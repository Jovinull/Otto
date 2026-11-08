# Operação

## Custos estimados

**Cloudflare:** zero no plano gratuito. Uso esperado de ~850 requisições/dia contra 100.000, 2 de 5 Cron Triggers, poucos milhares de linhas escritas por dia contra 100.000. Os limites diários resetam às 00:00 UTC; se forem atingidos, o D1 recusa consultas até o reset (o Telegram reenvia o webhook e o inbox absorve).

**OpenAI** (preços de 08/11/2026 por milhão de tokens: `gpt-6-luna` US$ 0,10 entrada / 0,01 cache / 0,50 saída; `gpt-6.1-terra` US$ 1,00 / 0,05 / 5,00):

| Operação                                | Tokens aproximados          | Custo por chamada |
| --------------------------------------- | --------------------------- | ----------------- |
| Interpretação (Luna, `reasoning: none`) | ~1.300 entrada + ~150 saída | ~US$ 0,0002       |
| Análise (Terra, `reasoning: low`)       | ~2.500 entrada + ~600 saída | ~US$ 0,0055       |

Com 30 mensagens financeiras por dia e 20 análises por mês: cerca de **US$ 0,30/mês**. Comandos (`/gasto`, `/resumo`…) e conversa comum não custam nada. Os limites locais padrão (US$ 0,30/dia e US$ 3/mês) ficam bem acima disso.

Os preços estão em `OPENAI_PRICING_JSON` no `wrangler.jsonc`; atualize se a OpenAI mudar a tabela. Tokens de raciocínio são cobrados como saída e já vêm somados em `output_tokens`.

### Limites

- `OPENAI_DAILY_BUDGET_USD` e `OPENAI_MONTHLY_BUDGET_USD`: ao atingir, novas interpretações ficam adiadas (o casal recebe um aviso único; nada se perde) e voltam a rodar quando o período renova (UTC). Comandos continuam funcionando.
- Análises param em 80% dos limites e caem no relatório determinístico, preservando verba para interpretar registros.
- `AI_MAX_CALLS_PER_MEMBER_PER_MINUTE` (padrão 10).
- Acompanhe com `/ia` no grupo.

**No painel da OpenAI** (platform.openai.com): crie um projeto só para o Otto, gere a chave nesse projeto, defina em _Limits_ um orçamento mensal e alerta por e-mail, e use créditos pré-pagos sem recarga automática. Esse é o limite real de faturamento; o do Otto é uma estimativa.

## Monitoramento

- `/status` — fila (`retry`, `deferred`, `failed`).
- `GET /admin/status` — mesmos números e o outbox.
- `wrangler tail --env production` — eventos `event_processing_failed`, `delivery_failed`, `analysis_not_grounded`.
- Evento `failed`: o casal já recebeu "nada foi registrado"; basta reenviar a mensagem.

## Backup e restauração

O Time Travel do D1 cobre apenas 7 dias. Faça backup próprio pelo menos semanalmente:

```bash
pnpm backup              # gera backups/otto-prod-<data>.sql e .json
```

Guarde os arquivos fora do repositório, em local criptografado (contêm dados financeiros).

**Testar a restauração** (sem tocar em produção):

```bash
pnpm exec wrangler d1 execute DB --local --persist-to .wrangler/restore-test --file backups/otto-prod-<data>.sql
pnpm exec wrangler d1 execute DB --local --persist-to .wrangler/restore-test --command "SELECT count(*) FROM financial_transactions"
```

**Restaurar em produção** (último recurso): crie um banco novo (`wrangler d1 create otto-prod-restore`), importe o `.sql` com `--remote`, confira as contagens, aponte o `database_id` de produção para ele e publique. Assim o banco original continua intacto até a verificação.

## Retenção automática (Cron horário)

- Pendências de confirmação expiram em 24 h.
- `incoming_events` e `outgoing_messages` em estado final são apagados após 90 dias.
- Lançamentos, auditoria e uso de IA não expiram.
