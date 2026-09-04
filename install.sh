#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="HidroCondo"
REPO_URL="${HIDROCONDO_REPO:-https://github.com/jotanuior/HidroCondo.git}"
DEFAULT_DIR="${HIDROCONDO_DIR:-/opt/HidroCondo}"
BRANCH="${HIDROCONDO_BRANCH:-main}"

log(){ printf '\n\033[1;36m[%s]\033[0m %s\n' "$APP_NAME" "$*"; }
ok(){ printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[AVISO]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERRO]\033[0m %s\n' "$*" >&2; exit 1; }
command_exists(){ command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  command_exists sudo || die "Execute como root ou instale sudo."
  SUDO="sudo"
fi

install_base_packages(){
  log "Verificando dependências"
  if command_exists apt-get; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y git curl ca-certificates openssl gzip iproute2
  elif command_exists dnf; then
    $SUDO dnf install -y git curl ca-certificates openssl gzip iproute
  elif command_exists yum; then
    $SUDO yum install -y git curl ca-certificates openssl gzip iproute
  else
    die "Distribuição não suportada automaticamente. Instale git, curl, openssl e Docker."
  fi

  if ! command_exists docker; then
    log "Docker não encontrado; instalando Docker Engine"
    curl -fsSL https://get.docker.com | $SUDO sh
  fi
  $SUDO systemctl enable --now docker 2>/dev/null || true
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 não está disponível."
  ok "Dependências prontas"
}

port_in_use(){
  local p="$1"
  ss -lntH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$p$"
}

find_free_port(){
  local p="$1"
  while port_in_use "$p"; do p=$((p+1)); done
  printf '%s' "$p"
}

random_hex(){ openssl rand -hex "${1:-24}"; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/.git" && -f "$SCRIPT_DIR/docker-compose.yml" ]]; then
  APP_DIR="$SCRIPT_DIR"
else
  APP_DIR="$DEFAULT_DIR"
fi

install_base_packages

log "Preparando código em $APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  if [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]]; then
    die "$APP_DIR já existe e não é um repositório Git vazio."
  fi
  $SUDO mkdir -p "$(dirname "$APP_DIR")"
  if [[ -n "$SUDO" ]]; then $SUDO chown "$(id -u):$(id -g)" "$(dirname "$APP_DIR")" 2>/dev/null || true; fi
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fi
cd "$APP_DIR"
chmod +x install.sh update.sh backup.sh 2>/dev/null || true

if [[ ! -f .env ]]; then
  log "Criando configuração inicial e verificando portas"
  API_HOST_PORT="$(find_free_port 3000)"
  WEB_HOST_PORT="$(find_free_port 8080)"
  [[ "$WEB_HOST_PORT" == "$API_HOST_PORT" ]] && WEB_HOST_PORT="$(find_free_port $((WEB_HOST_PORT+1)))"

  if [[ "$API_HOST_PORT" != "3000" ]]; then warn "Porta 3000 ocupada; API usará $API_HOST_PORT."; fi
  if [[ "$WEB_HOST_PORT" != "8080" ]]; then warn "Porta 8080 ocupada; Web usará $WEB_HOST_PORT."; fi

  DB_PASSWORD="$(random_hex 18)"
  JWT_SECRET="$(random_hex 32)"
  TELEMETRY_API_KEY="$(random_hex 32)"
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  SERVER_IP="${SERVER_IP:-127.0.0.1}"
  PUBLIC_API_URL="${HIDROCONDO_PUBLIC_API_URL:-http://${SERVER_IP}:${API_HOST_PORT}}"

  cat > .env <<EOF
POSTGRES_DB=hidrocondo
POSTGRES_USER=hidrocondo
POSTGRES_PASSWORD=${DB_PASSWORD}
DATABASE_URL=postgres://hidrocondo:${DB_PASSWORD}@db:5432/hidrocondo
API_PORT=3000
API_HOST_PORT=${API_HOST_PORT}
WEB_HOST_PORT=${WEB_HOST_PORT}
JWT_SECRET=${JWT_SECRET}
TELEMETRY_API_KEY=${TELEMETRY_API_KEY}
VITE_API_URL=${PUBLIC_API_URL}
BACKUP_KEEP=30
EOF
  chmod 600 .env
else
  ok ".env existente preservado"
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

log "Validando Docker Compose"
docker compose config >/dev/null

log "Construindo e iniciando serviços"
docker compose up -d --build

log "Aguardando API"
API_PUBLIC_PORT="${API_HOST_PORT:-3000}"
HEALTH_OK=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${API_PUBLIC_PORT}/health" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
  sleep 2
done
if [[ "$HEALTH_OK" -ne 1 ]]; then
  docker compose ps
  docker compose logs --tail=120 api || true
  die "API não respondeu ao healthcheck."
fi

WEB_PUBLIC_PORT="${WEB_HOST_PORT:-8080}"
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; SERVER_IP="${SERVER_IP:-127.0.0.1}"

ok "Instalação concluída"
printf '\nPainel: http://%s:%s\nAPI:    http://%s:%s\nHealth: http://%s:%s/health\n' "$SERVER_IP" "$WEB_PUBLIC_PORT" "$SERVER_IP" "$API_PUBLIC_PORT" "$SERVER_IP" "$API_PUBLIC_PORT"
printf '\nLogin inicial: admin@hidrocondo.local\nSenha inicial: HidroCondo@2026\n'
printf '\nChave do Node-RED: %s\n' "$TELEMETRY_API_KEY"
printf '\nTroque a senha inicial após o primeiro acesso. Configuração salva em %s/.env\n' "$APP_DIR"
