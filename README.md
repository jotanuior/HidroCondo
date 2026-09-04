# HidroCondo

Plataforma multi-condomínio para monitoramento de consumo de água por telemetria.

## Arquitetura inicial

- `apps/api`: API Node.js + TypeScript + Express
- `apps/web`: painel React + Vite
- `db/init`: schema e dados de demonstração PostgreSQL
- `docker-compose.yml`: PostgreSQL + API + Web

Fluxo de telemetria:

`Sensor -> MQTT -> Node-RED -> HTTP POST -> HidroCondo API -> PostgreSQL`

## Sensor tipo 09

O sensor trabalha com contador cíclico de `001` a `999` e não passa por `000`.

Regras implementadas no backend:

- `045 -> 054 = 9`
- `997 -> 002 = 4`
- `990 -> 024 = 33`
- em caso de queda de comunicação, a nova leitura é comparada com a última leitura válida persistida
- o servidor mantém um acumulador virtual contínuo
- `dif`, `dif2` e `leitura_ant` recebidos do Node-RED não são usados como fonte oficial para sensor tipo 09
- retries HTTP podem usar `X-Event-Id`; sem ele, o backend também gera uma chave determinística a partir do payload

## Executar com Docker

```bash
cp .env.example .env
docker compose up -d --build
```

Painel: `http://localhost:8080`

API: `http://localhost:3000`

Healthcheck:

```bash
curl http://localhost:3000/health
```

## Usuário de demonstração

- E-mail: `admin@hidrocondo.local`
- Senha: `HidroCondo@2026`

Troque essas credenciais antes de produção.

## Envio do Node-RED

Endpoint:

```text
POST /api/v1/telemetria
```

Headers:

```text
Content-Type: application/json
X-API-Key: valor de TELEMETRY_API_KEY
```

Exemplo:

```bash
curl -X POST http://localhost:3000/api/v1/telemetria \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: dev-telemetry-key' \
  -H 'X-Event-Id: central-01-20260904-094725-090011000001' \
  -d '{
    "nivel":"054",
    "numero_serie_central":"CENTRAL-01",
    "numero_serie_sensor":"090011000001",
    "tipo_sensor":"09",
    "tipo_sensor recebido":"09",
    "data ATUAL":"2026-09-04T09:47:25-03:00"
  }'
```

Sensores ainda não cadastrados são criados automaticamente sem unidade vinculada. Depois podem ser associados ao condomínio, bloco e unidade pela administração.

## Variáveis de ambiente

Veja `.env.example`.

Principais variáveis:

- `DATABASE_URL`
- `JWT_SECRET`
- `TELEMETRY_API_KEY`
- `VITE_API_URL`

## Estado atual

Já existe a fundação funcional do projeto com banco multi-condomínio, autenticação, ingestão HTTP protegida, regra de rollover do tipo 09, deduplicação, API de resumo e painel inicial responsivo.

Próximas etapas: CRUD administrativo completo, vínculo visual de sensores, gráfico diário/mensal, alertas, relatórios, parametrização do fator de conversão e rotina de backup/update para VPS.
