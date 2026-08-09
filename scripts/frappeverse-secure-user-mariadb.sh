#!/usr/bin/env bash
set -euo pipefail

instance_dir="/home/goblin/frappeverse/mariadb-user"
config_file="${instance_dir}/my.cnf"
root_password_file="${instance_dir}/root-password"
admin_password_file="${instance_dir}/admin-password"

umask 077
if [[ ! -s "${root_password_file}" ]]; then
  openssl rand -hex 24 >"${root_password_file}"
fi
if [[ ! -s "${admin_password_file}" ]]; then
  openssl rand -base64 24 | tr -d '/+=\n' >"${admin_password_file}"
fi

root_password="$(sed -n '1p' "${root_password_file}")"
escaped_root_password="${root_password//\'/\'\'}"

if mariadb --host=127.0.0.1 --port=13306 --protocol=tcp -uroot -NBe "SELECT 1" >/dev/null 2>&1; then
  mariadb --host=127.0.0.1 --port=13306 --protocol=tcp -uroot --execute="ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY '${escaped_root_password}'; DELETE FROM mysql.user WHERE User = ''; FLUSH PRIVILEGES;"
fi

mariadb --host=127.0.0.1 --port=13306 --protocol=tcp -uroot -p"${root_password}" -NBe "SELECT CONCAT(VERSION(), ' secured')"
