#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-}"
password_file="${2:-}"
proposal="${3:-}"
reviewer="${4:-demo.checker@frappeverse.invalid}"

[[ "$base_url" =~ ^https?://[^/]+$ ]] || { printf 'Base URL must be an HTTP(S) origin\n' >&2; exit 64; }
[[ "$password_file" == /* && -f "$password_file" ]] || { printf 'Private password file is required\n' >&2; exit 66; }
[[ "$(stat -c '%a' "$password_file")" == "600" ]] || { printf 'Password file must have mode 600\n' >&2; exit 77; }
[[ "$proposal" =~ ^MST-WFP-[A-Za-z0-9-]+$ ]] || { printf 'Invalid workflow proposal name\n' >&2; exit 64; }
[[ "$reviewer" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { printf 'Invalid reviewer identity\n' >&2; exit 64; }
command -v curl >/dev/null && command -v python3 >/dev/null || { printf 'curl and python3 are required\n' >&2; exit 69; }

password="$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2]); assert isinstance(value,str) and len(value)>=16; print(value)' "$password_file" "$reviewer")"
cookie_jar="$(mktemp /tmp/muster-review-cookie.XXXXXX)"
cleanup() {
  rm -f -- "$cookie_jar"
}
trap cleanup EXIT

curl -fsS -c "$cookie_jar" -X POST "$base_url/api/method/login" \
  --data-urlencode "usr=$reviewer" --data-urlencode "pwd=$password" >/dev/null
bootstrap="$(curl -fsS -b "$cookie_jar" \
  "$base_url/api/method/muster.api.surface.bootstrap?route=%2Fdesk%2Fmuster-workflow-proposal%2F$proposal")"
csrf_token="$(printf '%s' "$bootstrap" | python3 -c 'import json,sys; value=json.load(sys.stdin).get("message",{}).get("csrf_token"); assert isinstance(value,str) and value; print(value)')"
receipt="$(curl -fsS -b "$cookie_jar" -X POST \
  -H "X-Frappe-CSRF-Token: $csrf_token" \
  "$base_url/api/method/muster.api.mission.review_proposal" \
  --data-urlencode "proposal=$proposal" --data-urlencode "action=approve" \
  --data-urlencode "idempotency_key=checker-${proposal}-approve")"

printf '%s' "$receipt" | python3 -c 'import json,sys; message=json.load(sys.stdin).get("message",{}); print(json.dumps({"proposal":message.get("proposal"),"status":message.get("status"),"executed":message.get("executed")}, separators=(",",":")))'
