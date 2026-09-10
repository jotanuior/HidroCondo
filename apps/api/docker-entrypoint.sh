#!/bin/sh
set -eu

# Chaves Asaas começam com '$' e podem ser interpretadas pelo Docker Compose.
# ASAAS_API_KEY_B64 permite armazenar a chave codificada em base64 no .env.
if [ -n "${ASAAS_API_KEY_B64:-}" ]; then
  ASAAS_API_KEY="$(printf '%s' "$ASAAS_API_KEY_B64" | base64 -d)"
  export ASAAS_API_KEY
fi

exec "$@"
