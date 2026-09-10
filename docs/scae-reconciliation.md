# Reconciliação SCAE → HidroCondo

A sincronização é unidirecional: SCAE → HidroCondo.

## Regras operacionais

- Usuário removido/incompleto no SCAE: desativado no HidroCondo, preservando histórico.
- Vínculos SCAE ausentes no snapshot: removidos apenas quando `source='SCAE'`.
- Condomínio removido do SCAE: marcado `active=false` e `scae_present=false` quando o snapshot explícito de condomínios é enviado.
- Ponto de instalação removido do SCAE: unidade marcada `active=false` e `scae_present=false`.
- Sensor tipo 09 removido/desativado no SCAE: sensor marcado `active=false`.
- Retorno do registro no SCAE: reativação automática.
- Registros criados manualmente no HidroCondo não são desativados por ausência no SCAE.
- Listagens operacionais ocultam inativos por padrão. Superadmin pode consultar `?include_inactive=true` nas rotas de condomínios, blocos, unidades e sensores.

## Snapshot de estrutura

O payload de `/api/v1/scae/estrutura/sync` deve enviar `condominiums`, `installation_points` e `sensors`, com `snapshot_complete=true`.

A lista de sensores continua restrita ao tipo 09.

## Conflitos

As respostas dos endpoints de sincronização incluem `conflict_details` com `scae_id`, entidade e motivo, sem sobrescrever cadastros conflitantes automaticamente.
