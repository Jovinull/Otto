# Operação

## Custos estimados

**Cloudflare:** zero no plano gratuito.

| Recurso       | Limite gratuito    | Uso esperado                                       |
| ------------- | ------------------ | -------------------------------------------------- |
| Requisições   | 100.000/dia        | ~1.500/dia (1.440 do Cron de 1 minuto + mensagens) |
| Cron Triggers | 5 por conta        | 2                                                  |
| D1 escrita    | 100.000 linhas/dia | Dezenas por mensagem (índices contam)              |
| D1 leitura    | 5 milhões/dia      | Consultas filtradas por índice                     |
| D1 tamanho    | 500 MB             | Eventos e outbox purgados após 90 dias             |

Os limites diários do D1 resetam às 00:00 UTC. Se forem atingidos, o D1 recusa consultas até o reset: o webhook devolve erro, o Telegram reenvia, e o inbox absorve.

**OpenAI** (preços de 08/11/2026 por milhão de tokens: `gpt-6-luna` US$ 0,10 entrada / 0,01 cache / 0,50 saída; `gpt-6.1-terra` US$ 1,00 / 0,05 / 5,00):

| Operação                                | Tokens aproximados          | Custo por chamada |
| --------------------------------------- | --------------------------- | ----------------- |
| Interpretação (Luna, `reasoning: none`) | ~1.300 entrada + ~150 saída | ~US$ 0,0002       |
| Análise (Terra, `reasoning: low`)       | ~2.500 entrada + ~600 saída | ~US$ 0,0055       |

Com 30 mensagens financeiras por dia e 20 análises por mês: cerca de **US$ 0,30/mês**. Comandos e conversa comum não custam nada. Esses números são estimativas: confirme com `pnpm smoke:openai -- --yes` e acompanhe `/ia`.

### Limites de custo

- `OPENAI_DAILY_BUDGET_USD` e `OPENAI_MONTHLY_BUDGET_USD`: ao atingir, interpretações ficam adiadas (aviso único, nada se perde, os comandos seguem funcionando) até o período renovar (UTC). Mensagens adiadas não bloqueiam as seguintes.
- Análises param em 80% dos limites e caem no relatório determinístico.
- `AI_MAX_CALLS_PER_MEMBER_PER_MINUTE` (padrão 10).
- **No painel da OpenAI:** projeto exclusivo, orçamento mensal com alerta e créditos pré-pagos sem recarga automática. Esse é o limite real de cobrança.

## Capacidade do plano gratuito (medida)

| Medida                                     | Resultado                            | Como foi medido                                 |
| ------------------------------------------ | ------------------------------------ | ----------------------------------------------- |
| CPU por evento (sem o tempo do banco)      | mediana 1,2–2,5 ms; pior caso 5,2 ms | `pnpm bench:cpu` (V8 do Node com `node:sqlite`) |
| Subrequisições por mensagem                | 11–19 comuns; ~32 numa análise       | `tests/integration/concurrency.test.ts`         |
| Subrequisições do Cron horário no pior dia | 35 com 3 cartões                     | `tests/integration/hourly-budget.test.ts`       |

Limites: 10 ms de CPU e 50 subrequisições por invocação. O Otto só começa um evento novo na mesma invocação se couber o pior caso (34 subrequisições), e só entrega uma mensagem se couber a entrega (3). O que não couber fica para a próxima invocação; o Cron roda a cada minuto. Uma fila de 20 mensagens acumuladas (ex.: depois de uma queda da OpenAI) é drenada em cerca de 10 a 20 minutos.

Ainda depende de observação em produção: CPU real no `workerd` (inclui a inicialização do isolate) e latência do D1. Acompanhe em Workers & Pages → otto → Metrics (CPU time) e com `wrangler tail`.

## Monitoramento

- `/status`: fila (`retry`, `deferred`, `failed`).
- `pnpm doctor:telegram`: erros de entrega do webhook.
- `wrangler tail --env production`: eventos `event_processing_failed`, `delivery_failed`, `lease_lost`, `admin_auth_failed`, `analysis_not_grounded`.
- Evento `failed`: o casal já recebeu "nada foi registrado"; basta reenviar.

## Backup e restauração

O Time Travel do D1 cobre apenas 7 dias. O backup próprio é a garantia de longo prazo.

**Frequência e retenção recomendadas:** semanal e antes de toda migração; manter as últimas 12 semanas (`OTTO_BACKUP_KEEP=12` apaga os mais antigos da pasta de backup automaticamente). Guarde uma cópia mensal fora do computador (pendrive ou nuvem pessoal), sempre criptografada.

```powershell
$env:OTTO_BACKUP_PASSPHRASE = "<senha de backup>"
pnpm backup:prod
pnpm restore:test -- "<arquivo .sql.enc gerado>"
```

O que o backup garante:

- **Conteúdo:** exportação completa via `wrangler d1 export` (SQL).
- **Manifesto:** data, ambiente, commit, última migração, sha256 e contagem de linhas de 12 tabelas.
- **Criptografia:** AES-256-GCM com chave derivada por scrypt, quando `OTTO_BACKUP_PASSPHRASE` está definida. Sem senha, o arquivo fica em texto puro e o script avisa.
- **Local:** fora do repositório (`%USERPROFILE%\otto-backups` ou `OTTO_BACKUP_DIR`). O script recusa caminhos dentro do projeto.

O que a restauração de teste confere:

- Senha e integridade (sha256).
- Reordenação do dump: o `d1 export` cria tabelas filhas antes das tabelas pai.
- Importação num D1 local **temporário e isolado**, nunca o de produção nem o do `pnpm dev`.
- Contagem de linhas igual ao manifesto e chaves estrangeiras íntegras.

**Validação feita até aqui:** backup e restauração testados com o banco local. O dump remoto de produção ainda não foi restaurado; faça isso no primeiro backup real.

### Automatizar o backup semanal (Windows, sem custo)

O Agendador de Tarefas do Windows roda o backup na sua máquina. A senha precisa ficar guardada no computador: use isso apenas num PC pessoal com disco criptografado (BitLocker).

```powershell
[Environment]::SetEnvironmentVariable('OTTO_BACKUP_PASSPHRASE', '<senha>', 'User')
[Environment]::SetEnvironmentVariable('OTTO_BACKUP_KEEP', '12', 'User')
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -Command "Set-Location C:\Workspace\Otto; pnpm backup:prod *> $env:USERPROFILE\otto-backups\ultimo-backup.log"'
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 10am
Register-ScheduledTask -TaskName 'Otto backup semanal' -Action $action -Trigger $trigger
```

A tarefa só roda com o computador ligado e o login do Wrangler válido. Confira o log de vez em quando e teste uma restauração por mês.

Automação na nuvem (por exemplo, GitHub Actions agendado com um token da Cloudflare) é possível sem custo, mas exige publicar o repositório num serviço externo e guardar um token com acesso ao banco. Não foi configurada: é uma decisão de vocês.

### Restaurar em produção

Último recurso. Não sobrescreva o banco atual; restaure num banco novo:

```powershell
pnpm restore:test -- "<backup.sql.enc>" --export-sql "$env:USERPROFILE\otto-restore.sql"
pnpm exec wrangler d1 create otto-prod-restore
pnpm exec wrangler d1 execute otto-prod-restore --remote --file "$env:USERPROFILE\otto-restore.sql"
```

Confira as contagens com `wrangler d1 execute otto-prod-restore --remote --command "SELECT count(*) FROM financial_transactions"`. Depois troque o `database_id` de produção em `wrangler.jsonc` pelo id do banco novo e rode `pnpm deploy:prod`. O banco antigo continua existindo até vocês decidirem apagá-lo pelo painel. Apague o `.sql` em texto puro depois de usar.

## Retenção automática (Cron horário)

- Pendências de confirmação expiram em 24 h.
- `incoming_events` e `outgoing_messages` em estado final são apagados após 90 dias. O texto das mensagens já é apagado assim que o processamento termina.
- Lançamentos, auditoria e uso de IA não expiram.
