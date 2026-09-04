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

ask_nginx_mode(){
  if [[ -n "${HIDROCONDO_NGINX_MODE:-}" ]]; then
    NGINX_MODE="${HIDROCONDO_NGINX_MODE}"
  else
    printf '\nComo o HidroCondo será publicado?\n'
    printf '  1) Nginx EXTERNO já instalado na VPS (recomendado quando a VPS hospeda vários sistemas)\n'
    printf '  2) Nginx INTERNO no Docker (HidroCondo controla o proxy)\n'
    while true; do
      read -r -p 'Escolha [1/2]: ' choice
      case "$choice" in
        1) NGINX_MODE="external"; break ;;
        2) NGINX_MODE="internal"; break ;;
        *) warn "Digite 1 ou 2." ;;
      esac
    done
  fi
  [[ "$NGINX_MODE" == "external" || "$NGINX_MODE" == "internal" ]] || die "HIDROCONDO_NGINX_MODE deve ser external ou internal."

  if [[ -n "${HIDROCONDO_DOMAIN:-}" ]]; then
    DOMAIN="${HIDROCONDO_DOMAIN}"
  else
    read -r -p 'Domínio que será usado (ex.: hidrocondo.tecmen.com.br; deixe vazio para usar o IP): ' DOMAIN
  fi
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/.git" && -f "$SCRIPT_DIR/docker-compose.yml" ]]; then
  APP_DIR="$SCRIPT_DIR"
else
  APP_DIR="$DEFAULT_DIR"
fi

install_base_packages
ask_nginx_mode

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
  PROXY_HOST_PORT="80"
  if [[ "$NGINX_MODE" == "internal" ]]; then
    PROXY_HOST_PORT="$(find_free_port 80)"
  fi

  [[ "$API_HOST_PORT" != "3000" ]] && warn "Porta 3000 ocupada; API local usará $API_HOST_PORT."
  [[ "$WEB_HOST_PORT" != "8080" ]] && warn "Porta 8080 ocupada; Web local usará $WEB_HOST_PORT."
  if [[ "$NGINX_MODE" == "internal" && "$PROXY_HOST_PORT" != "80" ]]; then
    warn "Porta 80 ocupada; Nginx interno usará $PROXY_HOST_PORT."
  fi

  DB_PASSWORD="$(random_hex 18)"
  JWT_SECRET="$(random_hex 32)"
  TELEMETRY_API_KEY="$(random_hex 32)"
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  SERVER_IP="${SERVER_IP:-127.0.0.1}"

  if [[ -n "$DOMAIN" ]]; then
    if [[ "$NGINX_MODE" == "external" ]]; then
      PUBLIC_API_URL="https://${DOMAIN}"
    elif [[ "$PROXY_HOST_PORT" == "80" ]]; then
      PUBLIC_API_URL="http://${DOMAIN}"
    else
      PUBLIC_API_URL="http://${DOMAIN}:${PROXY_HOST_PORT}"
    fi
  else
    if [[ "$NGINX_MODE" == "external" ]]; then
      PUBLIC_API_URL="http://${SERVER_IP}:${WEB_HOST_PORT}"
      warn "Sem domínio no modo externo: após configurar o Nginx, ajuste VITE_API_URL e reconstrua o web."
    elif [[ "$PROXY_HOST_PORT" == "80" ]]; then
      PUBLIC_API_URL="http://${SERVER_IP}"
    else
      PUBLIC_API_URL="http://${SERVER_IP}:${PROXY_HOST_PORT}"
    fi
  fi

  cat > .env <<EOF
POSTGRES_DB=hidrocondo
POSTGRES_USER=hidrocondo
POSTGRES_PASSWORD=${DB_PASSWORD}
DATABASE_URL=postgres://hidrocondo:${DB_PASSWORD}@db:5432/hidrocondo
API_PORT=3000
API_HOST_PORT=${API_HOST_PORT}
WEB_HOST_PORT=${WEB_HOST_PORT}
PROXY_HOST_PORT=${PROXY_HOST_PORT}
NGINX_MODE=${NGINX_MODE}
HIDROCONDO_DOMAIN=${DOMAIN}
JWT_SECRET=${JWT_SECRET}
TELEMETRY_API_KEY=${TELEMETRY_API_KEY}
VITE_API_URL=${PUBLIC_API_URL}
BACKUP_KEEP=30
EOF
  chmod 600 .env
else
  ok ".env existente preservado"
  set -a; source .env; set +a
  NGINX_MODE="${NGINX_MODE:-${NGINX_MODE:-external}}"
  DOMAIN="${HIDROCONDO_DOMAIN:-$DOMAIN}"
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

log "Validando Docker Compose"
docker compose config >/dev/null

log "Construindo e iniciando serviços"
if [[ "${NGINX_MODE:-external}" == "internal" ]]; then
  docker compose --profile internal-nginx up -d --build
else
  docker compose up -d --build
fi

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

if [[ "${NGINX_MODE:-external}" == "external" ]]; then
  printf '\n============================================================\n'
  printf 'NGINX EXTERNO - CONFIGURAÇÃO A ADICIONAR\n'
  printf '============================================================\n\n'
  if [[ -n "${HIDROCONDO_DOMAIN:-}" ]]; then
    printf 'Crie, por exemplo: /etc/nginx/conf.d/hidrocondo.conf\n\n'
    cat <<EOF
server {
    listen 80;
    server_name ${HIDROCONDO_DOMAIN};

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PUBLIC_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = /health {
        proxy_pass http://127.0.0.1:${API_PUBLIC_PORT}/health;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:${WEB_PUBLIC_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
    printf '\nDepois execute:\n'
    printf '  nginx -t && systemctl reload nginx\n'
    printf '  certbot --nginx -d %s   # se usar Certbot para HTTPS\n' "$HIDROCONDO_DOMAIN"
    printf '\nApós HTTPS estar ativo, a aplicação já foi compilada apontando para https://%s.\n' "$HIDROCONDO_DOMAIN"
  else
    warn "Domínio não informado. Web local: http://${SERVER_IP}:${WEB_PUBLIC_PORT}; API local: http://${SERVER_IP}:${API_PUBLIC_PORT}."
  fi
else
  PROXY_PUBLIC_PORT="${PROXY_HOST_PORT:-80}"
  if [[ "$PROXY_PUBLIC_PORT" == "80" ]]; then
    printf '\nAcesso pelo Nginx interno: http://%s\n' "${HIDROCONDO_DOMAIN:-$SERVER_IP}"
  else
    printf '\nAcesso pelo Nginx interno: http://%s:%s\n' "${HIDROCONDO_DOMAIN:-$SERVER_IP}" "$PROXY_PUBLIC_PORT"
  fi
  printf 'O proxy reverso está dentro do Docker (profile internal-nginx).\n'
fi

printf '\nAPI local:    http://127.0.0.1:%s\n' "$API_PUBLIC_PORT"
printf 'Web local:    http://127.0.0.1:%s\n' "$WEB_PUBLIC_PORT"
printf 'Health local: http://127.0.0.1:%s/health\n' "$API_PUBLIC_PORT"
printf '\nLogin inicial: admin@hidrocondo.local\nSenha inicial: HidroCondo@2026\n'
printf '\nChave do Node-RED: %s\n' "$TELEMETRY_API_KEY"
printf '\nTroque a senha inicial após o primeiro acesso. Configuração salva em %s/.env\n' "$APP_DIR"
