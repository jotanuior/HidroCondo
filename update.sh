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
WEB_PUBLIC_PORT="${WEB_HOST_PORT:-8080}"
NGINX_MODE="${NGINX_MODE:-external}"

compose_up(){
  if [[ "$NGINX_MODE" == "internal" ]]; then
    docker compose --profile internal-nginx up -d --build --force-recreate api web
    docker compose --profile internal-nginx up -d
  else
    docker compose up -d --build --force-recreate api web
    docker compose up -d db
  fi
}

compose_ps(){
  if [[ "$NGINX_MODE" == "internal" ]]; then
    docker compose --profile internal-nginx ps
  else
    docker compose ps
  fi
}

services_healthy(){
  curl -fsS "http://127.0.0.1:${API_PUBLIC_PORT}/health" >/dev/null 2>&1 && \
  curl -fsSI "http://127.0.0.1:${WEB_PUBLIC_PORT}/" >/dev/null 2>&1
}

wait_services(){
  local i
  for i in $(seq 1 60); do
    if services_healthy; then return 0; fi
    sleep 2
  done
  return 1
}

run_migrations(){
  if [[ -x ./migrate.sh ]]; then
    log "Aplicando migrations do banco"
    ./migrate.sh
  fi
}

log "Consultando GitHub"
git fetch origin "$BRANCH"
INSTALLED="$(git rev-parse HEAD)"
AVAILABLE="$(git rev-parse "origin/$BRANCH")"
printf 'Instalado : %s\nDisponível: %s\n' "$INSTALLED" "$AVAILABLE"
printf 'Nginx     : %s\n' "$NGINX_MODE"

if [[ "${1:-}" == "--check" ]]; then
  if [[ "$INSTALLED" == "$AVAILABLE" ]]; then ok "Sistema está na versão mais recente"; else warn "Há atualização disponível"; fi
  compose_ps
  exit 0
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "Há alterações locais em arquivos versionados. Revise antes de atualizar."
fi

PREVIOUS="$INSTALLED"
if [[ "$INSTALLED" != "$AVAILABLE" ]]; then
  log "Criando backup obrigatório"
  chmod +x backup.sh 2>/dev/null || true
  ./backup.sh

  log "Atualizando código"
  if ! git pull --ff-only origin "$BRANCH"; then
    die "Falha no git pull. Nenhuma alteração de runtime foi aplicada."
  fi
else
  ok "Código já está atualizado"
fi

chmod +x install.sh update.sh backup.sh migrate.sh 2>/dev/null || true

# Sempre reconstrói API e frontend. Isso evita o caso em que o Git já foi
# atualizado manualmente, mas os containers ainda executam uma imagem antiga.
log "Reconstruindo API e frontend"
set +e
compose_up
COMPOSE_RC=$?
set -e
if [[ "$COMPOSE_RC" -ne 0 ]]; then
  warn "Docker Compose retornou código $COMPOSE_RC. Verificando os serviços."
fi

if ! run_migrations; then
  if [[ "$PREVIOUS" != "$(git rev-parse HEAD)" ]]; then
    warn "Falha ao aplicar migration. Restaurando código anterior $PREVIOUS"
    git reset --hard "$PREVIOUS"
    set +e
    compose_up
    set -e
  fi
  die "Falha ao aplicar migrations do banco. O backup foi preservado quando aplicável."
fi

log "Validando API e frontend"
if ! wait_services; then
  warn "A versão atual não ficou operacional. Exibindo diagnóstico."
  compose_ps || true
  docker compose logs --tail=160 api web || true
  if [[ "$PREVIOUS" != "$(git rev-parse HEAD)" ]]; then
    warn "Restaurando código anterior $PREVIOUS"
    git reset --hard "$PREVIOUS"
    set +e
    compose_up
    set -e
    die "Atualização revertida. Consulte o diagnóstico acima."
  fi
  die "Serviços não ficaram operacionais após o rebuild."
fi

NEW="$(git rev-parse HEAD)"
if [[ "$COMPOSE_RC" -ne 0 ]]; then
  warn "Compose retornou código não-zero, porém API e frontend responderam corretamente; versão mantida."
fi
if [[ "$PREVIOUS" == "$NEW" ]]; then
  ok "Runtime reconstruído e validado na versão $NEW"
else
  ok "Atualização concluída: $PREVIOUS -> $NEW"
fi
compose_ps
