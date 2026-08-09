#!/usr/bin/env bash
set -euo pipefail

bench_dir="/home/goblin/frappeverse/frappeverse-demo-v16"
site="frappeverse.local"
site_config="${bench_dir}/sites/${site}/site_config.json"
root_password_file="/home/goblin/frappeverse/mariadb-user/root-password"

site_user="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["db_user"])' "${site_config}")"
root_password="$(sed -n '1p' "${root_password_file}")"
new_password="$(openssl rand -hex 24)"

mapfile -t login_hosts < <(
  mariadb --host=127.0.0.1 --port=13306 --protocol=tcp -uroot -p"${root_password}" -NBe \
    "SELECT Host FROM mysql.user WHERE User = '${site_user}' ORDER BY Host"
)

if [[ "${#login_hosts[@]}" -eq 0 ]]; then
  echo "No database login exists for the site user" >&2
  exit 1
fi

for login_host in "${login_hosts[@]}"; do
  mariadb --host=127.0.0.1 --port=13306 --protocol=tcp -uroot -p"${root_password}" --execute \
    "ALTER USER '${site_user}'@'${login_host}' IDENTIFIED BY '${new_password}'"
done

cd "${bench_dir}"
bench --site "${site}" set-config db_password "${new_password}"
bench --site "${site}" list-apps >/dev/null
echo "site_database_password=rotated_and_verified"
