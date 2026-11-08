# Arquitetura

## Fluxo de uma mensagem

```text
Telegram ──POST /webhook/telegram──▶ Worker (Hono)
  1. valida X-Telegram-Bot-Api-Secret-Token (comparação em tempo constante)
  2. valida tamanho, JSON e formato do update (Zod)
  3. autoriza: grupo cadastrado E remetente ativo nesse Household
  4. grava em incoming_events (UNIQUE update_id e chat+message_id)  ◀── só então responde 200
  5. waitUntil(processEvent)  — caminho rápido, sem garantia
                                   │
Cron */2 min ──runRecovery──────────┤  retoma o que ficou pendente
                                   ▼
processEvent (lease exclusivo no evento)
  comando /…            → command-router (sem IA)
  resposta a pendência  → pending (preenche lacuna / confirma)
  texto natural         → filtro local → limites de custo → OpenAI (Structured Outputs)
                          → intent-router → regras do domínio
  ▼
UMA transação D1 (db.batch): lançamentos + auditoria + alertas + resposta no outbox + evento "processed"
  ▼
deliverDueMessages → Telegram sendMessage (retentativa com backoff; erro 4xx encerra)
```

Pontos centrais:

- **Persistir antes de confirmar.** Se a gravação no inbox falha, o webhook devolve 500 e o Telegram reenvia.
- **`waitUntil` não é garantia.** Se o Worker cair depois do 200, o evento continua `received` e o Cron das 2 em 2 minutos processa.
- **Lançamento e resposta na mesma transação.** Uma retentativa encontra o evento já `processed` e não grava de novo. Além disso, cada lançamento tem `idempotency_key` única (`<evento>:<índice>`), que o banco impõe.
- **Entrega separada da persistência.** Se o Telegram estiver fora, a resposta fica no outbox e o lançamento já está salvo. A entrega é "pelo menos uma vez": se o processo cair entre o Telegram aceitar e o outbox marcar como enviado, a mensagem pode repetir. O lançamento nunca repete.
- **Falha recuperável vs permanente.** Rede, timeout, 429 e 5xx voltam para a fila com backoff (30 s até 12 h, 9 tentativas). Erros 4xx do Telegram encerram a entrega. Ao esgotar tentativas, o evento vai para `failed` e o casal recebe "nada foi registrado".
- **Adiamento por custo não gasta tentativa.** Quando o limite de IA é atingido, o evento fica `deferred` até o limite renovar.

## Camadas

| Pasta                      | Responsabilidade                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/domain`               | Regras puras: resolução de lançamentos, contas padrão, orçamento, meta, recorrência, autorização. Sem I/O. |
| `src/shared`               | Dinheiro em centavos, datas civis com fuso, erros e logs sanitizados.                                      |
| `src/application/commands` | Casos de uso que escrevem. Devolvem comandos SQL; quem chama confirma tudo numa transação.                 |
| `src/application/queries`  | Agregações no banco e relatórios em texto.                                                                 |
| `src/application/services` | Roteamento de comandos e intenções, pendências, inbox, consultor, governança de IA, tom.                   |
| `src/application/jobs`     | Outbox e tarefas agendadas.                                                                                |
| `src/infrastructure`       | Drizzle/D1, cliente Telegram, cliente OpenAI (fetch direto).                                               |
| `src/interfaces/http`      | Rotas Hono: webhook, health e administração.                                                               |

O domínio não conhece o Telegram. A mensageria passa pela interface `MessagingGateway` e o evento de entrada é convertido em `InboundEvent`. Trocar por WhatsApp exige um novo adaptador e um novo endpoint, sem mexer nas regras financeiras.

## Decisões

| Decisão                                | Motivo                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI via `fetch`, sem SDK            | Uma chamada só (Responses API), menos bundle e controle explícito de timeout, `store: false` e tratamento de erro.                               |
| Drizzle gera SQL, Wrangler aplica      | Mantém migrações locais e remotas separadas (`--local` / `--remote --env production`).                                                           |
| TypeScript 6.0                         | `typescript-eslint` 8 suporta até `<6.1`.                                                                                                        |
| `@cloudflare/vitest-plugin`            | Sucessor oficial do `vitest-pool-workers`; testes rodam no `workerd` com D1 real.                                                                |
| Saldo sempre derivado                  | Não existe coluna de saldo mutável. Saldo = saldo inicial informado + entradas − saídas confirmadas. Sem saldo inicial, o Otto não afirma saldo. |
| Índices únicos com coluna de escopo    | Drizzle Kit 0.31 gera SQL inválido para índice com expressão; `scope_key` e `member_key` resolvem e deixam a regra explícita.                    |
| Ambiente padrão do Wrangler é só local | `wrangler deploy` sem `--env production` não publica (workers_dev desligado e banco fictício).                                                   |

## Limites do plano gratuito (verificados em 08/11/2026)

| Recurso             | Limite             | Uso esperado                                                                                                              |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Requisições Workers | 100.000/dia        | ~850/dia (720 do Cron de 2 min + mensagens)                                                                               |
| CPU por invocação   | 10 ms              | I/O de D1 e fetch não conta; o processamento de uma mensagem é leve. Se estourar, o evento fica no inbox e o Cron retoma. |
| Subrequisições      | 50 por invocação   | Cron processa no máximo 4 eventos e 10 entregas por execução.                                                             |
| Cron Triggers       | 5 por conta        | 2 usados                                                                                                                  |
| D1 escrita          | 100.000 linhas/dia | Dezenas por mensagem (índices contam)                                                                                     |
| D1 leitura          | 5 milhões/dia      | Consultas filtradas por índice                                                                                            |
| D1 tamanho          | 500 MB por banco   | Eventos e outbox são purgados após 90 dias                                                                                |
| Time Travel         | 7 dias             | Backup próprio em `pnpm backup`                                                                                           |
