#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="HidroCondo"
BRANCH="${HIDROCONDO_BRANCH:-main}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log(){ printf '\n\033[1;36m[%s]\033[0m %s\n' "$APP_NAME" "$*"; }
ok(){ printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[AVISO]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERRO]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d .git ]] || die "Execute este script dentro do diretório do HidroCondo."
[[ -f .env ]] || die ".env não encontrado. Rode ./install.sh primeiro."
command -v docker >/dev/null 2>&1 || die "Docker não encontrado."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 não encontrado."

set -a
# shellcheck disable=SC1091
source .env
set +a
API_PUBLIC_PORT="${API_HOST_PORT:-3000}"

log "Consultando GitHub"
git fetch origin "$BRANCH"
INSTALLED="$(git rev-parse HEAD)"
AVAILABLE="$(git rev-parse "origin/$BRANCH")"
printf 'Instalado : %s\nDisponível: %s\n' "$INSTALLED" "$AVAILABLE"

if [[ "${1:-}" == "--check" ]]; then
  if [[ "$INSTALLED" == "$AVAILABLE" ]]; then ok "Sistema está na versão mais recente"; else warn "Há atualização disponível"; fi
  docker compose ps
  exit 0
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "Há alterações locais em arquivos versionados. Revise antes de atualizar."
fi

if [[ "$INSTALLED" == "$AVAILABLE" ]]; then
  ok "Código já está atualizado"
  docker compose ps
  exit 0
fi

log "Criando backup obrigatório"
chmod +x backup.sh 2>/dev/null || true
./backup.sh

PREVIOUS="$INSTALLED"
log "Atualizando código"
if ! git pull --ff-only origin "$BRANCH"; then
  die "Falha no git pull. Nenhuma alteração de runtime foi aplicada."
fi
chmod +x install.sh update.sh backup.sh 2>/dev/null || true

log "Reconstruindo containers"
if ! docker compose up -d --build; then
  warn "Falha no build/start. Restaurando código anterior $PREVIOUS"
  git reset --hard "$PREVIOUS"
  docker compose up -d --build || true
  die "Atualização revertida no código. O backup do banco foi preservado."
fi

log "Validando healthcheck"
HEALTH_OK=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${API_PUBLIC_PORT}/health" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
  sleep 2
done

if [[ "$HEALTH_OK" -ne 1 ]]; then
  warn "Nova versão não respondeu. Restaurando código anterior $PREVIOUS"
  docker compose logs --tail=120 api || true
  git reset --hard "$PREVIOUS"
  docker compose up -d --build || true
  die "Atualização revertida. Consulte os logs e o backup criado antes da atualização."
fi

NEW="$(git rev-parse HEAD)"
ok "Atualização concluída: $PREVIOUS -> $NEW"
docker compose ps
