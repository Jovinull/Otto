# Otto

Assistente financeiro conversacional para um casal, num grupo privado do Telegram. Roda em Cloudflare Workers (plano gratuito) com banco D1 e usa a OpenAI apenas para interpretar linguagem natural e redigir análises. Todo número exibido vem de cálculo determinístico no banco.

## O que funciona

- Registro de despesas, receitas, transferências, compras no cartão, parcelamentos e pagamento de fatura, por linguagem natural ou por comandos (`/gasto 25,50 mercado`), com aviso de lançamento repetido.
- Faturas por ciclo de fechamento e vencimento, com pagamento parcial, crédito e parcelas futuras (`/fatura`).
- Cadastro guiado pelo Telegram (`/configurar`), que só ativa as configurações depois da confirmação.
- Consultas reais no banco: gastos por período, categoria e pessoa, entradas e saídas, maiores despesas, saldos conhecidos, contas a pagar, renda prevista.
- Orçamentos mensais por categoria, geral ou por pessoa, com alertas em 80%, 100% e ultrapassagem (uma vez por mês por limiar).
- Meta do apartamento: alvo, guardado confirmado, progresso, falta, aporte necessário e projeção (sem rendimentos). Aporte pretendido nunca conta como guardado.
- Recorrências (aluguel, contas, salário) como previsão; viram "pago/recebido" só quando o casal relata.
- Correções e estornos com confirmação e trilha de auditoria.
- Mensagens proativas no fuso do Household: contas a vencer, alertas, resumo semanal, fechamento mensal, acompanhamento da meta.
- Fila durável (inbox/outbox no D1) com idempotência, retentativas com backoff, recuperação por Cron, processamento em ordem por chat e proteção contra conclusão por quem perdeu o lease.
- Backup criptografado com manifesto e restauração verificada num banco isolado; diagnósticos (`doctor`, `doctor:telegram`) e smoke test real da OpenAI.
- Controle de custo de IA: registro de tokens e custo estimado, limites diário e mensal, limite por pessoa por minuto.

Limitações conhecidas estão em [docs/domain.md](docs/domain.md#limitações-conhecidas).

## Requisitos

- Node.js 22 ou superior
- pnpm 10 ou superior (`corepack enable` instala)
- Git

Nada precisa ser instalado globalmente: Wrangler, Drizzle Kit e Vitest são dependências locais.

## Executar localmente

```bash
pnpm install
cp .dev.vars.example .dev.vars        # segredos falsos para desenvolvimento
pnpm db:migrate:local                 # cria o D1 local em .wrangler/state
pnpm dev                              # Worker em http://127.0.0.1:8787
```

Em outro terminal, cadastre um Household de teste e converse com ele:

```bash
OTTO_HOUSEHOLD_NAME="Casa Teste" OTTO_TELEGRAM_CHAT_ID=-1001 \
OTTO_MEMBER_1_NAME=Felipe OTTO_MEMBER_1_TELEGRAM_ID=1001 \
OTTO_MEMBER_2_NAME=Jennifer OTTO_MEMBER_2_TELEGRAM_ID=1002 \
pnpm bootstrap:household -- --local

pnpm simulate -- --chat -1001 --from 1001 "/gasto 27,50 uber"
pnpm simulate -- --chat -1001 --from 1001 "/resumo"
```

No Git Bash do Windows, exporte `MSYS_NO_PATHCONV=1` antes, senão argumentos começando com `/` viram caminhos de arquivo.

Sem token real do Telegram, as respostas ficam no outbox e a entrega falha com `telegram_404` no log. Para ver os dados, use `pnpm exec wrangler d1 execute DB --local --persist-to .wrangler/state --command "SELECT * FROM financial_transactions"`. Sem `OPENAI_API_KEY`, mensagens em linguagem natural ficam na fila (`ai_not_configured`) e os comandos funcionam normalmente.

## Verificações

```bash
pnpm test         # 530+ testes no runtime do Workers com D1 local
pnpm test:scripts # testes do backup (Node)
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build        # bundle de produção (dry-run)
pnpm check        # tudo acima
pnpm bench:cpu    # CPU por evento, sem o tempo do banco
```

## Colocar no ar

Comece por [docs/first-deployment.md](docs/first-deployment.md): do BotFather ao primeiro backup, com comandos para PowerShell e Git Bash. Roteiro de teste com o grupo real em [docs/manual-test.md](docs/manual-test.md).

## Testes com serviços reais (opcionais)

Não rodam na CI e só consomem créditos com `--yes`:

```bash
pnpm smoke:openai -- --yes      # chave, modelo servido, saída estruturada, custo
pnpm eval:openai -- --yes       # 44 mensagens do conjunto em evals/, taxa de acerto por tipo
pnpm doctor:telegram            # somente leitura
pnpm run doctor -- --remote     # configuração e Cloudflare (com `run`: `pnpm doctor` é um comando do próprio pnpm)
```

## Documentação

| Documento                                            | Conteúdo                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| [docs/first-deployment.md](docs/first-deployment.md) | Primeira implantação, passo a passo                            |
| [docs/architecture.md](docs/architecture.md)         | Fluxo, ordem por chat, orçamento por invocação e decisões      |
| [docs/domain.md](docs/domain.md)                     | Regras financeiras, entidades e limitações                     |
| [docs/commands.md](docs/commands.md)                 | Sintaxe de todos os comandos                                   |
| [docs/security.md](docs/security.md)                 | Proteções, privacidade, retenção e riscos                      |
| [docs/telegram-setup.md](docs/telegram-setup.md)     | BotFather, grupo, Privacy Mode, IDs e webhook                  |
| [docs/deployment.md](docs/deployment.md)             | Cloudflare, segredos, migrações, publicação e rollback         |
| [docs/operations.md](docs/operations.md)             | Custos, capacidade medida, monitoramento, backup e restauração |
| [docs/manual-test.md](docs/manual-test.md)           | Roteiro ponta a ponta para o grupo real                        |
