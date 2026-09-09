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

## Ficha do sensor e gestão de vínculos

Clique no serial ou no botão de detalhes. A ficha reúne propriedade da conta, responsável pelo sensor, responsável da unidade, instalação, configuração, comunicação, usuários autorizados e histórico. Administradores gerenciam os sensores no seu escopo. Moradores consultam os dados do equipamento sem lista de usuários nem ações administrativas.

O responsável pelo sensor precisa ser um usuário ativo que já tenha acesso ao equipamento. Essa designação não concede acesso novo. O responsável da unidade é o nome cadastral existente, que pode ser corrigido com justificativa por administradores do condomínio.

A propriedade é da conta. Sua troca afeta todos os equipamentos dessa conta, exige um administrador ativo já membro dela e pode ser feita pelo Super Admin ou por um administrador com gestão da conta inteira. O proprietário anterior mantém a associação administrativa; revogá-la é uma ação separada. A troca não modifica o perfil global dos usuários.

Somente o Super Admin transfere um sensor entre contas ou vincula um sensor sem conta. A operação exige destino e justificativa, encerra a instalação e limpa o responsável. Acessos e convites pendentes compartilhados diretamente no sensor são revogados; acessos herdados da antiga conta/unidade deixam de alcançar o equipamento. O histórico permanece armazenado, e as consultas da nova conta começam na data da transferência. Super Admin conserva consulta ao histórico anterior. Ocorrências mantêm seus vínculos de origem. O contador físico acumulado não é zerado pela transferência.

Condomínios criados anteriormente sem conta podem ser regularizados pelo Super Admin, em Usuários e vínculos → Regularizar condomínio sem conta. A ação não transfere condomínios que já possuem conta e recusa sensores instalados incompatíveis. Depois da regularização, instale o sensor na unidade da mesma conta.

## Proteção da auditoria (migração 008)

`audit_log` e `alert_occurrence_events` rejeitam UPDATE, DELETE e TRUNCATE por triggers. Os novos registros capturam nome e perfil do autor na inserção, mantendo-os após renomear o usuário. Os registros existentes recebem o nome disponível na migração; isso não comprova retroativamente a integridade histórica. Mudanças de responsabilidade e propriedade registram antes, depois e justificativa na mesma transação da alteração. A ficha mostra até 100 registros recentes.

Essa proteção impede alterações pelas operações normais da aplicação e comandos SQL comuns. Não é armazenamento WORM nem garante proteção contra o administrador do PostgreSQL: o proprietário do banco/superusuário pode remover triggers ou restaurar backups alterados. O Compose atual usa as credenciais configuradas em DATABASE_URL e não muda automaticamente o papel de conexão. Para resistência também ao administrador do banco, é necessária segregação de credenciais e cópia externa com retenção imutável; nenhuma integração externa foi configurada nesta entrega.

A exclusão física de usuários referenciados pela auditoria pode ser bloqueada: use desativação para preservar a identidade. Backup e migração continuam usando o fluxo existente; a nova migração deve preceder o início da API.
