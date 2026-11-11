#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
if [ -e .env ]; then
    echo '.env already exists; left unchanged.'
    exit 0
fi

umask 077
temp_env=$(mktemp ./.env.XXXXXX)
trap 'rm -f "$temp_env"' EXIT
trap 'exit 1' HUP INT TERM
dashboard_password=$(openssl rand -hex 12)
encryption_key=$(openssl rand -hex 32)
postgres_password=$(openssl rand -hex 20)
admin_key=$(openssl rand -hex 24)
cat > "$temp_env" <<EOF
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=$dashboard_password
DASHBOARD_ENCRYPTION_KEY=$encryption_key
POSTGRES_PASSWORD=$postgres_password
APISIX_ADMIN_KEY=$admin_key
EOF
# Publish the complete file without replacing credentials created by another process.
ln "$temp_env" .env
echo 'Created .env with unique local credentials. Keep this file private.'
