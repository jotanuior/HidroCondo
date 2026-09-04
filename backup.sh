#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log(){ printf '\n\033[1;36m[HidroCondo]\033[0m %s\n' "$*"; }
ok(){ printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERRO]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f .env ]] || die ".env não encontrado."
command -v docker >/dev/null 2>&1 || die "Docker não encontrado."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 não encontrado."

set -a
# shellcheck disable=SC1091
source .env
set +a

BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
KEEP="${BACKUP_KEEP:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

log "Gerando backup PostgreSQL"
docker compose ps --status running db | grep -q db || die "Container do PostgreSQL não está em execução."

docker compose exec -T db pg_dump \
  -U "${POSTGRES_USER:-hidrocondo}" \
  -d "${POSTGRES_DB:-hidrocondo}" \
  --clean --if-exists --no-owner --no-privileges \
  | gzip -9 > "$BACKUP_DIR/hidrocondo-${STAMP}.sql.gz"

cp .env "$BACKUP_DIR/hidrocondo-${STAMP}.env"
chmod 600 "$BACKUP_DIR/hidrocondo-${STAMP}.env"

if [[ "$KEEP" =~ ^[0-9]+$ ]] && (( KEEP > 0 )); then
  mapfile -t OLD_SQL < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'hidrocondo-*.sql.gz' -printf '%T@ %p\n' | sort -nr | tail -n +$((KEEP+1)) | cut -d' ' -f2-)
  for f in "${OLD_SQL[@]:-}"; do
    [[ -n "$f" ]] || continue
    base="${f%.sql.gz}"
    rm -f "$f" "${base}.env"
  done
fi

ok "Backup criado: $BACKUP_DIR/hidrocondo-${STAMP}.sql.gz"
