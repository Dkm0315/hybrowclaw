#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

ACTION="${1:-plan}"
BENCH_DIR="${BENCH_DIR:-}"
SITE_NAME="${SITE_NAME:-frappeverse-demo.local}"
RESTORE_SITE="${RESTORE_SITE:-frappeverse-restore.local}"
FRAPPE_REF="${FRAPPE_REF:-version-16}"
FRAPPE_BRANCH="${FRAPPE_BRANCH:-version-16}"
PYTHON_BIN="${PYTHON_BIN:-python3.14}"
APPS_LOCK_FILE="${APPS_LOCK_FILE:-}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://frappeverse-demo.example.invalid}"
MUSTER_PUBLIC_ORIGIN="${MUSTER_PUBLIC_ORIGIN:-https://muster-demo.example.invalid}"
RECORDING_MODE="${RECORDING_MODE:-rehearsal}"
SEED_PASSWORD_FILE="${SEED_PASSWORD_FILE:-}"
ARTIFACT_DIR="${ARTIFACT_DIR:-}"
SERVICE_PREFIX="${SERVICE_PREFIX:-frappeverse-demo}"
WEB_PORT="${WEB_PORT:-8200}"
SOCKETIO_PORT="${SOCKETIO_PORT:-9200}"
REDIS_CACHE_PORT="${REDIS_CACHE_PORT:-13200}"
REDIS_QUEUE_PORT="${REDIS_QUEUE_PORT:-13201}"
REDIS_SOCKETIO_PORT="${REDIS_SOCKETIO_PORT:-13202}"
MUSTER_GATEWAY_PORT="${MUSTER_GATEWAY_PORT:-7200}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '[frappeverse] %s\n' "$*"; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"; }

preferred_remote() {
  local repo_dir="$1" remote
  for remote in upstream origin; do
    git -C "$repo_dir" remote get-url "$remote" >/dev/null 2>&1 && { printf '%s\n' "$remote"; return; }
  done
  remote="$(git -C "$repo_dir" remote | head -n 1)"
  [[ -n "$remote" ]] || die "No Git remote configured for $repo_dir"
  printf '%s\n' "$remote"
}

reviewed_remote() {
  local repo_dir="$1" expected="$2" remote actual
  while IFS= read -r remote; do
    [[ -n "$remote" ]] || continue
    actual="$(git -C "$repo_dir" remote get-url "$remote")"
    [[ "$actual" == "$expected" ]] && { printf '%s\n' "$remote"; return; }
  done < <(git -C "$repo_dir" remote)
  die "No Git remote for $repo_dir matches reviewed repository $expected"
}

acquire_mutation_lock() {
  require_command flock
  local lock_file="/tmp/${SERVICE_PREFIX}.provision.lock"
  exec 9>"$lock_file"
  flock -n 9 || die "Another ${SERVICE_PREFIX} provisioning operation is already running"
}

run_resource_intensive() {
  # Asset builds can create intense CPU and filesystem pressure on a shared
  # Frappe host. Keep interactive Desk, SSH, and existing sites responsive.
  if command -v ionice >/dev/null 2>&1; then
    ionice -c 2 -n 7 nice -n 10 "$@"
  else
    nice -n 10 "$@"
  fi
}

validate() {
  [[ "$ACTION" =~ ^(plan|inspect|provision|seed|verify|backup|restore-rehearsal|all)$ ]] || die "Unknown action: $ACTION"
  [[ -n "$BENCH_DIR" && "$BENCH_DIR" = /* && "$BENCH_DIR" != / && "$BENCH_DIR" != "$HOME" ]] || die "BENCH_DIR must be an explicit safe absolute path"
  [[ "$SITE_NAME" =~ ^[a-z0-9][a-z0-9.-]+$ ]] || die "Unsafe SITE_NAME"
  [[ "$RESTORE_SITE" =~ ^frappeverse-restore[.a-z0-9-]*$ && "$RESTORE_SITE" != "$SITE_NAME" ]] || die "RESTORE_SITE must be a distinct frappeverse-restore site"
  [[ "$SERVICE_PREFIX" =~ ^[a-z][a-z0-9-]{2,39}$ ]] || die "Unsafe SERVICE_PREFIX"
  [[ "$FRAPPE_BRANCH" == "version-16" ]] || die "FRAPPE_BRANCH must remain version-16"
  local port seen_ports=" "
  for port in "$WEB_PORT" "$SOCKETIO_PORT" "$REDIS_CACHE_PORT" "$REDIS_QUEUE_PORT" "$REDIS_SOCKETIO_PORT" "$MUSTER_GATEWAY_PORT"; do
    [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1024 && "$port" -le 65535 ]] || die "Every service port must be between 1024 and 65535"
    [[ "$seen_ports" != *" $port "* ]] || die "Service ports must be unique"
    seen_ports+="$port "
  done
  [[ "$PUBLIC_ORIGIN" =~ ^https://[^/]+$ && "$MUSTER_PUBLIC_ORIGIN" =~ ^https://[^/]+$ ]] || die "Origins must be HTTPS origins without paths"
  if [[ "$RECORDING_MODE" == "final" ]]; then
    [[ ! "$PUBLIC_ORIGIN $MUSTER_PUBLIC_ORIGIN" =~ (trycloudflare\.com|ngrok|loca\.lt|localhost|127\.0\.0\.1|\.example\.invalid) ]] || die "Final recording refuses tunnels, localhost, and placeholder origins"
    [[ "$FRAPPE_REF" =~ ^[a-f0-9]{40}$ ]] || die "Final recording requires an immutable Frappe v16 commit"
  fi
  [[ -n "$APPS_LOCK_FILE" && -f "$APPS_LOCK_FILE" ]] || die "APPS_LOCK_FILE must name the reviewed TSV lock"
  [[ -n "$ARTIFACT_DIR" && "$ARTIFACT_DIR" = /* && "$ARTIFACT_DIR" != / ]] || die "ARTIFACT_DIR must be an explicit absolute path"
  if [[ -n "$SEED_PASSWORD_FILE" ]]; then
    [[ -f "$SEED_PASSWORD_FILE" ]] || die "SEED_PASSWORD_FILE does not exist"
    local password_mode
    password_mode="$(stat -f '%Lp' "$SEED_PASSWORD_FILE" 2>/dev/null || stat -c '%a' "$SEED_PASSWORD_FILE")"
    [[ "$password_mode" == "600" || "$password_mode" == "400" ]] || die "SEED_PASSWORD_FILE must be chmod 600 or 400"
  fi
}

ensure_new_bench_ports_free() {
  [[ -d "$BENCH_DIR" ]] && return
  require_command ss
  local listening port
  listening="$(ss -ltnH | awk '{print $4}')"
  for port in "$WEB_PORT" "$SOCKETIO_PORT" "$REDIS_CACHE_PORT" "$REDIS_QUEUE_PORT" "$REDIS_SOCKETIO_PORT" "$MUSTER_GATEWAY_PORT"; do
    grep -Eq "(^|:)$port$" <<<"$listening" && die "Port $port is already in use; choose a reviewed isolated port block"
  done
}

inspect() {
  note "target_host=$(hostname) bench=$BENCH_DIR site=$SITE_NAME"
  if [[ ! -d "$BENCH_DIR" ]]; then note "bench_state=absent"; return; fi
  [[ -f "$BENCH_DIR/sites/common_site_config.json" ]] || die "Existing target is not a Bench directory"
  (cd "$BENCH_DIR" && bench version)
  (cd "$BENCH_DIR" && bench --site "$SITE_NAME" list-apps) 2>/dev/null || note "site_state=absent"
  for app_dir in "$BENCH_DIR"/apps/*; do
    [[ -d "$app_dir/.git" ]] || continue
    local remote
    remote="$(preferred_remote "$app_dir")"
    printf 'app=%s remote_name=%s remote=%s revision=%s\n' "$(basename "$app_dir")" "$remote" "$(git -C "$app_dir" remote get-url "$remote")" "$(git -C "$app_dir" rev-parse HEAD)"
  done
  ps -ef | grep -E "[f]rappe|[b]ench|[g]unicorn|[r]edis|[s]ocketio" || true
}

validate_lock() {
  local app repo branch ref required first_app=""
  while IFS=$'\t' read -r app repo branch ref required; do
    [[ -z "$app" || "$app" == \#* ]] && continue
    [[ -n "$first_app" ]] || first_app="$app"
    [[ "$app" =~ ^[a-z][a-z0-9_]*$ && "$repo" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]] || die "Invalid app lock row for $app"
    [[ "$branch" =~ ^[A-Za-z0-9._/-]{1,120}$ && "$required" == "true" ]] || die "Every app needs a reviewed bootstrap branch and must be required"
    if [[ "$RECORDING_MODE" == "final" || "${ALLOW_MUTABLE_REFS:-0}" != "1" ]]; then
      [[ "$ref" =~ ^[a-f0-9]{40}$ ]] || die "$app must be pinned to a 40-character commit"
    fi
  done < "$APPS_LOCK_FILE"
  [[ "$first_app" == "erpnext" ]] || die "ERPNext must be the first app installed after Frappe"
}

ensure_bench() {
  require_command bench
  require_command git
  require_command mariadb
  ensure_new_bench_ports_free
  if [[ ! -d "$BENCH_DIR" ]]; then
    note "Creating isolated Frappe v16 bench; this downloads code and Python/Node dependencies"
    bench init --frappe-branch "$FRAPPE_BRANCH" --python "$PYTHON_BIN" "$BENCH_DIR"
  fi
  [[ -f "$BENCH_DIR/sites/common_site_config.json" ]] || die "Bench initialization did not complete"
  local frappe_remote
  frappe_remote="$(reviewed_remote "$BENCH_DIR/apps/frappe" "https://github.com/frappe/frappe.git")"
  git -C "$BENCH_DIR/apps/frappe" fetch --tags "$frappe_remote"
  git -C "$BENCH_DIR/apps/frappe" checkout --detach "$FRAPPE_REF"
  [[ "$(git -C "$BENCH_DIR/apps/frappe" rev-parse HEAD)" == "$FRAPPE_REF" || "${ALLOW_MUTABLE_REFS:-0}" == "1" ]] || die "Frappe did not resolve to its locked commit"
}

configure_ports() {
  # Bench's sibling-port discovery compares these values numerically. Writing
  # quoted strings here breaks subsequent `bench init` runs in the same parent.
  (cd "$BENCH_DIR" && bench set-config -g webserver_port "$WEB_PORT" --parse)
  (cd "$BENCH_DIR" && bench set-config -g socketio_port "$SOCKETIO_PORT" --parse)
  (cd "$BENCH_DIR" && bench set-config -g redis_cache "redis://127.0.0.1:$REDIS_CACHE_PORT")
  (cd "$BENCH_DIR" && bench set-config -g redis_queue "redis://127.0.0.1:$REDIS_QUEUE_PORT")
  (cd "$BENCH_DIR" && bench set-config -g redis_socketio "redis://127.0.0.1:$REDIS_SOCKETIO_PORT")
  (cd "$BENCH_DIR" && bench setup redis)
  (cd "$BENCH_DIR" && bench setup procfile)
}

ensure_app() {
  local app="$1" repo="$2" branch="$3" ref="$4" app_dir="$BENCH_DIR/apps/$1" remote
  if [[ ! -d "$app_dir/.git" ]]; then
    (cd "$BENCH_DIR" && bench get-app --branch "$branch" "$app" "$repo")
  fi
  remote="$(reviewed_remote "$app_dir" "$repo")"
  git -C "$app_dir" fetch --tags "$remote"
  git -C "$app_dir" checkout --detach "$ref"
  [[ "$(git -C "$app_dir" rev-parse HEAD)" == "$ref" || "${ALLOW_MUTABLE_REFS:-0}" == "1" ]] || die "$app did not resolve to its locked commit"
}

ensure_site() {
  if [[ ! -d "$BENCH_DIR/sites/$SITE_NAME" ]]; then
    note "Creating MariaDB site. Bench will securely prompt for database-root and Administrator passwords; input is not accepted through command arguments."
    (cd "$BENCH_DIR" && bench new-site "$SITE_NAME" --db-type mariadb)
  fi
  (cd "$BENCH_DIR" && bench --site "$SITE_NAME" set-config host_name "$PUBLIC_ORIGIN")
}

install_apps() {
  local app repo branch ref required installed
  while IFS=$'\t' read -r app repo branch ref required; do
    [[ -z "$app" || "$app" == \#* ]] && continue
    ensure_app "$app" "$repo" "$branch" "$ref"
  done < "$APPS_LOCK_FILE"
  (cd "$BENCH_DIR" && bench setup requirements)
  installed="$(cd "$BENCH_DIR" && bench --site "$SITE_NAME" list-apps --format text 2>/dev/null || true)"
  while IFS=$'\t' read -r app repo branch ref required; do
    [[ -z "$app" || "$app" == \#* ]] && continue
    if ! grep -Fxq "$app" <<<"$installed"; then
      (cd "$BENCH_DIR" && bench --site "$SITE_NAME" install-app "$app")
    fi
  done < "$APPS_LOCK_FILE"
  (cd "$BENCH_DIR" && bench --site "$SITE_NAME" migrate)
  (cd "$BENCH_DIR" && run_resource_intensive bench build --production)
}

write_service_manifest() {
  mkdir -p "$ARTIFACT_DIR"
  {
    printf 'service_prefix=%s\n' "$SERVICE_PREFIX"
    printf 'web_service=%s-web\n' "$SERVICE_PREFIX"
    printf 'socketio_service=%s-socketio\n' "$SERVICE_PREFIX"
    printf 'worker_service=%s-workers\n' "$SERVICE_PREFIX"
    printf 'scheduler_service=%s-scheduler\n' "$SERVICE_PREFIX"
    printf 'gateway_service=%s-muster-gateway\n' "$SERVICE_PREFIX"
    printf 'site=%s\npublic_origin=%s\nmuster_origin=%s\n' "$SITE_NAME" "$PUBLIC_ORIGIN" "$MUSTER_PUBLIC_ORIGIN"
    printf 'web_port=%s\nsocketio_port=%s\nredis_cache_port=%s\nredis_queue_port=%s\nredis_socketio_port=%s\ngateway_port=%s\n' "$WEB_PORT" "$SOCKETIO_PORT" "$REDIS_CACHE_PORT" "$REDIS_QUEUE_PORT" "$REDIS_SOCKETIO_PORT" "$MUSTER_GATEWAY_PORT"
  } > "$ARTIFACT_DIR/services.env"
}

seed() {
  local kwargs='{"confirm":True}'
  if [[ -n "$SEED_PASSWORD_FILE" ]]; then
    kwargs="{\"confirm\":True,\"password_file\":$(printf '%s' "$SEED_PASSWORD_FILE" | "$PYTHON_BIN" -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
  fi
  mkdir -p "$ARTIFACT_DIR"
  (cd "$BENCH_DIR" && bench --site "$SITE_NAME" execute muster.demo.frappeverse_baseline.seed --kwargs "$kwargs") > "$ARTIFACT_DIR/baseline-seed.json"
}

verify() {
  local app repo branch ref required installed
  mkdir -p "$ARTIFACT_DIR"
  installed="$(cd "$BENCH_DIR" && bench --site "$SITE_NAME" list-apps --format text)"
  [[ "$(git -C "$BENCH_DIR/apps/frappe" rev-parse HEAD)" == "$FRAPPE_REF" || "${ALLOW_MUTABLE_REFS:-0}" == "1" ]] || die "Frappe revision drifted"
  while IFS=$'\t' read -r app repo branch ref required; do
    [[ -z "$app" || "$app" == \#* ]] && continue
    grep -Fxq "$app" <<<"$installed" || die "Required app is not installed: $app"
    [[ "$(git -C "$BENCH_DIR/apps/$app" rev-parse HEAD)" == "$ref" || "${ALLOW_MUTABLE_REFS:-0}" == "1" ]] || die "$app revision drifted"
  done < "$APPS_LOCK_FILE"
  (cd "$BENCH_DIR" && bench --site "$SITE_NAME" migrate)
  (cd "$BENCH_DIR" && bench --site "$SITE_NAME" execute muster.demo.frappeverse_baseline._outcome_counts) > "$ARTIFACT_DIR/muster-outcome-counts.json"
  write_service_manifest
}

backup() {
  mkdir -p "$ARTIFACT_DIR"
  (cd "$BENCH_DIR" && bench --site "$SITE_NAME" backup --with-files --compress) | tee "$ARTIFACT_DIR/backup.log"
}

restore_rehearsal() {
  [[ "${ALLOW_RESTORE_REHEARSAL:-}" == "YES" ]] || die "Set ALLOW_RESTORE_REHEARSAL=YES for the isolated restore site"
  [[ -n "${RESTORE_SQL:-}" && -f "$RESTORE_SQL" ]] || die "RESTORE_SQL must identify the reviewed backup"
  mkdir -p "$ARTIFACT_DIR"
  if [[ ! -d "$BENCH_DIR/sites/$RESTORE_SITE" ]]; then
    note "Creating isolated restore site. Bench will securely prompt for database-root and Administrator passwords."
    (cd "$BENCH_DIR" && bench new-site "$RESTORE_SITE" --db-type mariadb)
    local restore_args=(bench --site "$RESTORE_SITE" restore "$RESTORE_SQL")
    [[ -n "${RESTORE_PUBLIC_FILES:-}" ]] && restore_args+=(--with-public-files "$RESTORE_PUBLIC_FILES")
    [[ -n "${RESTORE_PRIVATE_FILES:-}" ]] && restore_args+=(--with-private-files "$RESTORE_PRIVATE_FILES")
    (cd "$BENCH_DIR" && "${restore_args[@]}")
  fi
  (cd "$BENCH_DIR" && bench --site "$RESTORE_SITE" migrate)
  (cd "$BENCH_DIR" && bench --site "$RESTORE_SITE" list-apps --format text) > "$ARTIFACT_DIR/restore-apps.txt"
  (cd "$BENCH_DIR" && bench --site "$RESTORE_SITE" execute muster.demo.frappeverse_baseline._outcome_counts) > "$ARTIFACT_DIR/restore-outcome-counts.json"
}

validate
validate_lock
if [[ ! "$ACTION" =~ ^(plan|inspect)$ ]]; then
  acquire_mutation_lock
fi
case "$ACTION" in
  plan) inspect; note "Plan only: no state changed" ;;
  inspect) inspect ;;
  provision) inspect; ensure_bench; configure_ports; ensure_site; install_apps; write_service_manifest ;;
  seed) seed ;;
  verify) verify ;;
  backup) backup ;;
  restore-rehearsal) restore_rehearsal ;;
  all) inspect; ensure_bench; configure_ports; ensure_site; install_apps; seed; verify; backup ;;
esac
