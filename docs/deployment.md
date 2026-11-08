# Publicação na Cloudflare

Tudo no plano gratuito, em `*.workers.dev`. Nenhum domínio próprio, nenhum billing.

## Ambientes

|                | Local (padrão)                                             | Produção                                 |
| -------------- | ---------------------------------------------------------- | ---------------------------------------- |
| Comando        | `pnpm dev`                                                 | `pnpm deploy` (`--env production`)       |
| Nome do Worker | `otto-local` (nunca publicado: `workers_dev: false`)       | `otto`                                   |
| Banco          | `.wrangler/state` (id fictício)                            | `otto-prod`                              |
| Segredos       | `.dev.vars`                                                | `wrangler secret put … --env production` |
| Migrações      | `pnpm db:migrate:local`                                    | `pnpm db:migrate:prod`                   |
| Cron           | não roda sozinho (dispare em `/cdn-cgi/handler/scheduled`) | `*/2 * * * *` e `0 * * * *` (UTC)        |

## Primeira publicação

1. **Login:** `pnpm exec wrangler login` (abre o navegador). Confira com `pnpm exec wrangler whoami`.
2. **Banco:** `pnpm exec wrangler d1 create otto-prod`. Copie o `database_id` retornado para `env.production.d1_databases[0].database_id` em `wrangler.jsonc` (substituindo `REPLACE_WITH_D1_DATABASE_ID`). O id não é segredo.
3. **Migrações:** `pnpm db:migrate:prod`.
4. **Segredos** (cada comando pede o valor no terminal; nunca coloque em arquivo versionado):
   ```bash
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN --env production
   pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production   # A-Z a-z 0-9 _ -
   pnpm exec wrangler secret put ADMIN_API_TOKEN --env production
   pnpm exec wrangler secret put OPENAI_API_KEY --env production
   ```
   Para gerar valores aleatórios: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
5. **Publicar:** `pnpm deploy`. Anote a URL `https://otto.<subdominio>.workers.dev`.
6. **Saúde:** `curl https://otto.<subdominio>.workers.dev/health` → `{"ok":true}`.
7. **`.env` local** com `OTTO_BASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` e `ADMIN_API_TOKEN` (mesmos valores dos segredos).
8. **Webhook:** `pnpm telegram:webhook`.
9. **IDs e bootstrap:** [telegram-setup.md](telegram-setup.md), passos 4 e 5.

## Atualizações

```bash
pnpm check                 # testes, tipos, lint, formato, build
pnpm db:generate           # somente se o schema mudou; revise o SQL gerado
pnpm db:migrate:local && pnpm test
pnpm backup                # antes de migrar produção
pnpm db:migrate:prod
pnpm deploy
```

Migrações devem ser aditivas. Nunca rode comandos destrutivos com `--remote` sem backup.

## Rollback

- **Código:** `pnpm exec wrangler deployments list --env production` e `pnpm exec wrangler rollback <deployment-id> --env production`.
- **Dados:** D1 Time Travel guarda 7 dias no plano gratuito: `pnpm exec wrangler d1 time-travel info otto-prod` e `… time-travel restore otto-prod --timestamp=<ISO>`. Restaurar sobrescreve o banco inteiro. Para períodos maiores, use o backup próprio ([operations.md](operations.md)).
- Um rollback de código não desfaz migrações; por isso mantenha migrações compatíveis com a versão anterior.

## Diagnóstico

- `GET /health` — banco acessível.
- `GET /admin/status` com `Authorization: Bearer $ADMIN_API_TOKEN` — contagem de eventos e mensagens por estado.
- `/status` e `/ia` no grupo.
- `pnpm exec wrangler tail --env production` — logs ao vivo (JSON sem dados financeiros).
- `pnpm telegram:webhook -- --info` — erros de entrega do Telegram.
