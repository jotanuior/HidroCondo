#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] || { echo '[ERRO] .env não encontrado'; exit 1; }
set -a
# shellcheck disable=SC1091
source .env
set +a
DB_NAME="${POSTGRES_DB:-hidrocondo}"
DB_USER="${POSTGRES_USER:-hidrocondo}"

echo '[HidroCondo] Aguardando PostgreSQL'
for _ in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  sleep 2
done

docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

for file in db/migrations/*.sql; do
  [[ -e "$file" ]] || continue
  name="$(basename "$file")"
  applied="$(docker compose exec -T db psql -At -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1 FROM schema_migrations WHERE filename='${name//\'/\'\'}' LIMIT 1")"
  if [[ "$applied" == "1" ]]; then
    echo "[OK] $name já aplicada"
    continue
  fi
  echo "[HidroCondo] Aplicando $name"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$file"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO schema_migrations(filename) VALUES ('${name//\'/\'\'}')"
done

echo '[OK] Migrations concluídas'
