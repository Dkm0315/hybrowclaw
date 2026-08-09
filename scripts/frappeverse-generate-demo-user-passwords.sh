#!/usr/bin/env bash
set -euo pipefail

output_path="${1:-}"
[[ -n "$output_path" ]] || {
  printf 'Usage: %s /absolute/private/path.json\n' "$0" >&2
  exit 64
}
[[ "$output_path" == /* ]] || {
  printf 'Password output path must be absolute\n' >&2
  exit 64
}
[[ -d "$(dirname "$output_path")" ]] || {
  printf 'Password output directory does not exist\n' >&2
  exit 66
}
[[ ! -e "$output_path" ]] || {
  printf 'Refusing to overwrite an existing password file\n' >&2
  exit 73
}
command -v openssl >/dev/null || {
  printf 'openssl is required\n' >&2
  exit 69
}

umask 077
temporary_path="$(mktemp "${output_path}.tmp.XXXXXX")"
cleanup() {
  [[ ! -e "$temporary_path" ]] || rm -f -- "$temporary_path"
}
trap cleanup EXIT

owner_password="$(openssl rand -hex 24)"
checker_password="$(openssl rand -hex 24)"
sales_password="$(openssl rand -hex 24)"
hr_password="$(openssl rand -hex 24)"
support_password="$(openssl rand -hex 24)"
finance_password="$(openssl rand -hex 24)"
auditor_password="$(openssl rand -hex 24)"

{
  printf '{\n'
  printf '  "demo.owner@frappeverse.invalid": "%s",\n' "$owner_password"
  printf '  "demo.checker@frappeverse.invalid": "%s",\n' "$checker_password"
  printf '  "demo.sales@frappeverse.invalid": "%s",\n' "$sales_password"
  printf '  "demo.hr@frappeverse.invalid": "%s",\n' "$hr_password"
  printf '  "demo.support@frappeverse.invalid": "%s",\n' "$support_password"
  printf '  "demo.finance@frappeverse.invalid": "%s",\n' "$finance_password"
  printf '  "demo.auditor@frappeverse.invalid": "%s"\n' "$auditor_password"
  printf '}\n'
} >"$temporary_path"
chmod 600 "$temporary_path"
mv "$temporary_path" "$output_path"
trap - EXIT

printf 'Created private demo credential file: %s (7 users, mode 600)\n' "$output_path"
