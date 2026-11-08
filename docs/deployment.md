# Publicação na Cloudflare

Tudo no plano gratuito, em `*.workers.dev`, sem domínio próprio nem billing. O passo a passo da primeira vez, com Telegram e OpenAI, está em [first-deployment.md](first-deployment.md). Este documento é a referência técnica.

## Ambientes

|                | Local (padrão)                                             | Produção                                 |
| -------------- | ---------------------------------------------------------- | ---------------------------------------- |
| Comando        | `pnpm dev`                                                 | `pnpm deploy:prod`                       |
| Nome do Worker | `otto-local` (nunca publicado: `workers_dev: false`)       | `otto`                                   |
| Banco          | `.wrangler/state` (id fictício)                            | `otto-prod`                              |
| Segredos       | `.dev.vars`                                                | `wrangler secret put … --env production` |
| Migrações      | `pnpm db:migrate:local`                                    | `pnpm db:migrate:prod`                   |
| Cron           | não roda sozinho (dispare em `/cdn-cgi/handler/scheduled`) | `* * * * *` e `0 * * * *` (UTC)          |

`pnpm deploy` (sem `:prod`) é um comando nativo do pnpm e não publica o Otto.

## Ordem da primeira publicação

1. `pnpm exec wrangler login`
2. `pnpm exec wrangler d1 create otto-prod` e copiar o `database_id` para `env.production` em `wrangler.jsonc`.
3. `pnpm db:migrate:prod`
4. `pnpm deploy:prod`: sem segredos, o webhook recusa tudo (seguro).
5. `wrangler secret put` para `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ADMIN_API_TOKEN` e `OPENAI_API_KEY`. Cada `secret put` publica uma versão nova automaticamente.
6. `pnpm doctor -- --remote`
7. `pnpm telegram:webhook`, `/id` no grupo e `pnpm bootstrap:household`.

Segredos são cadastrados **depois** do primeiro deploy porque `secret put` num Worker inexistente pede para criá-lo de forma interativa.

## Variáveis de produção (`wrangler.jsonc`, não secretas)

| Variável                                                | Padrão               | Uso                                      |
| ------------------------------------------------------- | -------------------- | ---------------------------------------- |
| `OPENAI_MODEL_FAST`                                     | `gpt-6-luna`         | Interpretação                            |
| `OPENAI_MODEL_ANALYSIS`                                 | `gpt-6.1-terra`      | Análises                                 |
| `OPENAI_DAILY_BUDGET_USD` / `OPENAI_MONTHLY_BUDGET_USD` | `0.30` / `3`         | Limites locais de custo                  |
| `OPENAI_PRICING_JSON`                                   | preços de 08/11/2026 | Base do custo estimado                   |
| `AI_MAX_CALLS_PER_MEMBER_PER_MINUTE`                    | `10`                 | Limite por pessoa                        |
| `ADMIN_ALLOW_EXPORT` / `ADMIN_ALLOW_ERASE`              | ausentes (desligado) | Liberam `/admin/export` e `/admin/erase` |

Para exportar por HTTP, publique temporariamente com a variável e depois volte ao normal:

```powershell
pnpm exec wrangler deploy --env production --var ADMIN_ALLOW_EXPORT:true
# ... use GET /admin/export com o token ...
pnpm deploy:prod
```

Para backups, prefira `pnpm backup:prod`, que não depende desse endpoint.

## Atualizações

```powershell
pnpm check
pnpm db:generate             # só se o schema mudou; revise o SQL gerado
pnpm db:migrate:local
pnpm test
pnpm backup:prod             # antes de migrar produção
pnpm db:migrate:prod
pnpm deploy:prod
pnpm doctor -- --remote
```

Migrações devem ser aditivas, para que a versão anterior do código continue funcionando se for preciso voltar.

## Rollback

- **Código:** `pnpm exec wrangler deployments list --env production` e `pnpm exec wrangler rollback <id> --env production`.
- **Dados (até 7 dias):** `pnpm exec wrangler d1 time-travel info otto-prod` e `pnpm exec wrangler d1 time-travel restore otto-prod --timestamp <ISO>`. Isso sobrescreve o banco inteiro.
- **Dados mais antigos:** backup próprio ([operations.md](operations.md#restaurar-em-produção)).

## Diagnóstico

| Ferramenta                                 | O que mostra                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm doctor` / `pnpm doctor -- --remote`  | Configuração, segredos (só nomes), migrações, login, `/health`                           |
| `pnpm doctor:telegram`                     | Token, webhook, erros de entrega, permissões do bot e tamanho do grupo (somente leitura) |
| `pnpm smoke:openai -- --yes`               | Chave, modelo servido, saída estruturada, tokens e custo                                 |
| `GET /health`                              | Banco acessível                                                                          |
| `GET /admin/status` (token)                | Contagem de eventos e mensagens por estado                                               |
| `pnpm exec wrangler tail --env production` | Logs JSON sem dados financeiros                                                          |
