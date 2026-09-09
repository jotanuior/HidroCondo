# Integridade de medição — primeira etapa

Esta etapa preserva o layout e acrescenta controles de medição na tela Sensores.

## Comportamento

- `last_seen_at` registra a comunicação, inclusive uma retransmissão identificada.
- `last_reading_at` registra a última referência aceita ou conferida manualmente.
- Mensagens sem horário/identificador são heartbeats independentes; contador parado gera delta zero.
- `x-event-id` deve ser único por transmissão e estável nas tentativas de reenvio. O identificador é isolado por serial.
- Mensagens antigas, com horário conhecido, ficam no histórico com consumo zero.
- Uma redução sem limite físico configurado exige conferência. Não é possível distinguir reinício de volta apenas pelos dois números.
- Com vazão máxima configurada, a volta só é aceita se o volume couber no intervalo e esse intervalo não permitir múltiplas voltas.
- Uma leitura suspeita bloqueia incrementos subsequentes até conferência. Nenhum volume suspeito é somado automaticamente.
- Equipamento desativado mantém o histórico e recebe eventos com consumo zero até reativação explícita.

## Configuração e conferência

Em **Sensores → Configurar medição**, o administrador informa os dígitos reais (3 ou 6), o fator em m³ por incremento e, quando conhecido, a vazão máxima física em m³/h.

Exemplos: 1 litro = 0,001 m³; 10 litros = 0,01 m³ por incremento. Os fatores existentes são preservados: esta atualização não adivinha nem recalibra instalações.

Em **Ajustar hidrômetro**, informar a leitura física em m³ e a justificativa. Para liberar uma pendência, informar também o contador bruto atual, conferido no equipamento. O ajuste estabelece uma nova referência, guarda auditoria e não reescreve leituras históricas. Consumo do intervalo suspeito deve ser conciliado manualmente; não há distribuição estimada por dia.

Configurar seis dígitos não converte automaticamente equipamento antigo de três dígitos. Confirmar o firmware antes da alteração. Sem vazão máxima, aumentos continuam calculados pela diferença; quedas ficam pendentes. Sem horário ou sequência confiável, a origem de mensagens atrasadas não pode ser determinada com certeza.

## Atualização

Executar `./update.sh` após integrar esta branch. O script aplica a migration aditiva `006_measurement_integrity.sql` antes de recriar a API. O backup existente permanece obrigatório quando há atualização de código. `JWT_SECRET` precisa estar configurado e não pode ser `dev-secret`.

A migration preserva leituras existentes, não recalcula consumos antigos e impede exclusão física de sensores com telemetria. Mudar a unidade deve ocorrer por Instalar/Transferir, que preserva o histórico de instalações. A criação direta de inventário fica reservada ao superadmin; clientes usam Adicionar equipamento/claim.

## Validação

- `node --test apps/api/test/reading-policy.test.mjs`: cenários puros de cálculo, Node 22.18+.
- `npm run build`: compilação de API e frontend.
- `TEST_DATABASE_URL=postgres://.../hidrocondo_test npm test -w apps/api`: testes de integração, após compilar API, em banco exclusivo de testes.
- CI provisiona PostgreSQL 17 e executa migrações, testes e builds.

Próximas etapas: tratamento de acesso histórico em transferências entre contas, relatórios por intervalo de ocorrência, invalidação de sessões por troca de senha, ocorrências/notificações de alertas e dashboard por perfil. Esta etapa invalida imediatamente o acesso de usuário desativado e usa seu papel atual no banco.
