# Dashboard e ocorrências

O painel mostra os sensores e as unidades permitidos ao usuário. Moradores veem "Minha água"; administradores, "Visão da gestão"; demais perfis, "Operação dos condomínios". Consumo diário e mensal usa horário de Brasília. A comparação considera o mesmo tempo transcorrido do mês anterior, limitada ao fim desse mês. Sem base positiva, não exibe percentual.

Dias sem leituras aparecem como lacunas. Leituras suspeitas não somam consumo. Pendências de medição aparecem no painel. As listas mostram até 12 sensores prioritários e 24 unidades; as páginas Sensores e Unidades continuam disponíveis para consulta completa. O painel considera os sensores atualmente acessíveis; para histórico completo de instalações, use Relatórios.

## Ocorrências

A API avalia condições ao iniciar e a cada minuto. Um bloqueio no PostgreSQL evita avaliações simultâneas por várias instâncias. O painel atualiza a cada 30 segundos enquanto visível e informa a última avaliação.

- Sem comunicação: regra por condomínio, incluindo equipamento que nunca comunicou após o prazo.
- Consumo acima do limite: consumo por sensor instalado, em uma janela móvel de 1 a 10080 minutos.
- Conferência de leitura: automática quando o sensor tem pendência, sem necessidade de regra.

Administradores, síndicos e zeladores com permissão no local podem iniciar atendimento e resolver. Moradores e conselheiros consultam. Configurar regras é reservado a administradores autorizados.

Resolver exige uma justificativa. Enquanto a condição persistir, o sistema mantém a ocorrência encerrada sem criar duplicatas. Após recuperação e reincidência, cria uma nova ocorrência. Recuperação, desativação, mudança de instalação ou remoção/pausa da regra encerram a condição na próxima avaliação. Histórico registra datas, responsáveis e notas, preservando o local original. O acompanhamento ocorre dentro do sistema.

## Atualização e verificação

A versão exige a migração `007_alert_occurrences.sql`. O atualizador aplica as migrações antes de iniciar a nova API. `migrate.sh` passa a ser executável no repositório.

Após a integração em main, execute na VPS:

```bash
cd /opt/HidroCondo
bash update.sh
```

Verifique o dashboard e, em Alertas, a data de última avaliação. Configure um limite apropriado para o condomínio. Confira que o morador enxerga apenas suas unidades e que a equipe autorizada consegue registrar atendimento.

Validação automatizada: build API/web, testes com PostgreSQL 17 e testes Chromium para atendimento, morador em viewport móvel e falha de carregamento. As telas usam respostas simuladas nos testes Chromium; as regras e permissões são testadas contra PostgreSQL real.
