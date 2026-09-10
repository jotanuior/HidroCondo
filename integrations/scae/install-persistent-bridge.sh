#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${SCAE_WEB_CONTAINER:-lentec-web}"
TARGET_DIR="${HIDROCONDO_BRIDGE_DIR:-/opt/scae-hidrocondo}"
BRIDGE_URL="${HIDROCONDO_BRIDGE_URL:-https://raw.githubusercontent.com/jotanuior/HidroCondo/main/integrations/scae/hidrocondo-sso.html}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container $CONTAINER não encontrado. Defina SCAE_WEB_CONTAINER se necessário." >&2
  exit 1
fi

SERVICE="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$CONTAINER")"
WORKDIR="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$CONTAINER")"

if [[ -z "$SERVICE" || -z "$WORKDIR" || "$SERVICE" == "<no value>" || "$WORKDIR" == "<no value>" ]]; then
  echo "Não foi possível detectar serviço/diretório do Docker Compose." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
curl -fsSL "$BRIDGE_URL" -o "$TARGET_DIR/hidrocondo.html"
chmod 0644 "$TARGET_DIR/hidrocondo.html"

OVERRIDE="$WORKDIR/docker-compose.override.yml"
if [[ -f "$OVERRIDE" ]] && ! grep -q 'scae-hidrocondo/hidrocondo.html' "$OVERRIDE"; then
  BACKUP="$OVERRIDE.bak.$(date +%Y%m%d-%H%M%S)"
  cp -a "$OVERRIDE" "$BACKUP"
  echo "Já existe $OVERRIDE. Backup criado em $BACKUP." >&2
  echo "Por segurança o arquivo existente não será sobrescrito automaticamente." >&2
  echo "Adicione ao serviço '$SERVICE' o volume:" >&2
  echo "  - $TARGET_DIR/hidrocondo.html:/usr/share/nginx/html/hidrocondo.html:ro" >&2
  exit 2
fi

if [[ ! -f "$OVERRIDE" ]]; then
  cat > "$OVERRIDE" <<YAML
services:
  $SERVICE:
    volumes:
      - $TARGET_DIR/hidrocondo.html:/usr/share/nginx/html/hidrocondo.html:ro
YAML
fi

cd "$WORKDIR"
docker compose up -d "$SERVICE"

echo "Bridge persistente instalado."
echo "Serviço Compose: $SERVICE"
echo "Arquivo host: $TARGET_DIR/hidrocondo.html"
echo "Override: $OVERRIDE"
