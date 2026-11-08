# Arquitetura

## Fluxo de uma mensagem

```text
Telegram ──POST /webhook/telegram──▶ Worker (Hono)          (max_connections = 1)
  1. valida X-Telegram-Bot-Api-Secret-Token (hash comparado em tempo constante)
  2. valida tamanho, JSON e formato do update (Zod)
  3. autoriza: grupo cadastrado E remetente ativo nesse Household
  4. grava em incoming_events (UNIQUE update_id e chat+message_id)   ◀── só então responde 200
  5. waitUntil(processEvent): caminho rápido, sem garantia
                                    │
Cron a cada minuto ──runRecovery────┤  retoma o que ficou pendente
                                    ▼
claim atômico (um UPDATE no D1): lease + token, trava da lane do chat, ordem por update_id
  comando /…            → command-router (sem IA)
  resposta a pendência  → pending (lacuna, confirmação ou pergunta do cadastro guiado)
  texto natural         → filtro local → limites de custo → OpenAI (Structured Outputs)
                          → intent-router → regras do domínio
  ▼
UMA transação D1 (db.batch):
  guarda de posse do lease + lançamentos + auditoria + alertas + resposta no outbox + evento "processed"
  ▼
drena o próximo evento do mesmo chat (se couber no orçamento da invocação)
  ▼
deliverDueMessages → Telegram sendMessage (retentativa com backoff; erro 4xx encerra)
```

Pontos centrais:

- **Persistir antes de confirmar.** Se a gravação no inbox falha, o webhook devolve 500 e o Telegram reenvia.
- **`waitUntil` não é garantia.** Se o Worker cair depois do 200, o evento continua no inbox e o Cron o processa.
- **Lançamento e resposta na mesma transação.** Uma retentativa encontra o evento já `processed`. Cada lançamento também tem `idempotency_key` única, imposta pelo banco.
- **Entrega separada da persistência.** Telegram fora do ar só atrasa a resposta. A entrega é "pelo menos uma vez"; o lançamento, exatamente uma.
- **Recuperável vs permanente.** Rede, timeout, 429 e 5xx voltam para a fila com backoff (30 s até 12 h, 9 tentativas). 4xx do Telegram encerra a entrega. Esgotadas as tentativas, o evento vira `failed` e o casal recebe "nada foi registrado".

## Ordem e concorrência por chat

Política: os eventos de um chat são processados **um de cada vez, em ordem crescente de `update_id`**.

- `update_id` é a sequência global do bot e cobre mensagens, edições e cliques em botões. `message_id` só ordena mensagens e serve para deduplicar.
- **Trava da lane:** um evento só é reivindicado se nenhum outro do mesmo chat estiver em `processing` com lease válido.
- **Ordem:** um evento só é reivindicado se não houver evento anterior do chat em `received`, `retry` ou `processing` recebido nos últimos 3 minutos (`HEAD_OF_LINE_MS`). Depois disso o anterior deixa de bloquear, para uma falha prolongada (ex.: IA fora) não travar os comandos. Eventos `deferred` (limite de custo) nunca bloqueiam.
- As duas condições ficam no mesmo `UPDATE … WHERE NOT EXISTS (…)`. O SQLite executa escritas em série, então duas invocações concorrentes não reivindicam eventos do mesmo chat ao mesmo tempo. Não há mutex em memória.
- **Dreno:** ao terminar um evento, a invocação tenta o próximo do mesmo chat. O fast path de um evento que encontrou a lane ocupada simplesmente desiste; quem está processando, ou o Cron, segue para ele.
- **Posse do lease:** cada claim grava um `lease_token`. A transação final começa com um `INSERT … SELECT` na tabela `lease_guard`, que só insere (e viola um `CHECK`, desfazendo o lote inteiro) se o token não for mais o atual. Assim, um processamento lento cujo lease expirou e foi assumido por outro não grava nada, nem reagenda o evento.
- **Chegada fora de ordem:** o Telegram é configurado com `max_connections = 1`, o que entrega um update por vez. Um update que mesmo assim chegue depois de um posterior é processado normalmente; não se perde.
- **Evento defeituoso:** cada claim conta tentativa; depois de 9, o evento vai para `failed`. O bloqueio que ele causa dura no máximo a janela de ordem.

Testes: `tests/integration/concurrency.test.ts`.

## Orçamento por invocação (plano gratuito)

Cada consulta D1 e cada fetch contam como subrequisição (limite de 50 por invocação; um batch conta uma vez). O medidor `meterD1`/`meteredFetch` conta todas. Um evento novo só começa se couber o pior caso medido (34); uma entrega, se couber 3. Detalhes em [operations.md](operations.md#capacidade-do-plano-gratuito-medida).

## Camadas

| Pasta                      | Responsabilidade                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/domain`               | Regras puras: lançamentos, contas padrão, ciclo de fatura, orçamento, meta, recorrência, autorização. Sem I/O. |
| `src/shared`               | Dinheiro em centavos, datas civis com fuso, erros e logs sanitizados.                                          |
| `src/application/commands` | Casos de uso que escrevem. Devolvem comandos SQL; quem chama confirma tudo numa transação.                     |
| `src/application/queries`  | Agregações no banco, faturas e relatórios.                                                                     |
| `src/application/services` | Roteamento, pendências, cadastro guiado, inbox, consultor, governança de IA, tom.                              |
| `src/application/jobs`     | Outbox e tarefas agendadas.                                                                                    |
| `src/infrastructure`       | Drizzle/D1 (com medidor), cliente Telegram, cliente OpenAI (fetch direto).                                     |
| `src/interfaces/http`      | Rotas Hono: webhook, health e administração.                                                                   |
| `evals/`                   | Conjunto versionado de avaliação da interpretação e comparador.                                                |
| `scripts/`                 | Bootstrap, webhook, diagnósticos, smoke, avaliação real, backup e medição de CPU.                              |

O domínio não conhece o Telegram: a mensageria passa por `MessagingGateway` e o update vira `InboundEvent`. Um adaptador de WhatsApp não precisaria mexer nas regras financeiras.

## Decisões

| Decisão                             | Motivo                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI via `fetch`, sem SDK         | Uma chamada (Responses API), bundle menor, controle de timeout, `store: false` e erros.                                                 |
| Drizzle gera SQL, Wrangler aplica   | Migrações locais e remotas separadas.                                                                                                   |
| TypeScript 6.0                      | `typescript-eslint` 8 suporta até `<6.1`.                                                                                               |
| `@cloudflare/vitest-plugin`         | Testes no `workerd` com D1 real.                                                                                                        |
| `tsx` (dev)                         | Smoke e avaliação reais reutilizam o cliente, o schema e o prompt de produção.                                                          |
| Saldo sempre derivado               | Sem coluna de saldo mutável; sem saldo inicial, o Otto não afirma saldo.                                                                |
| Índices únicos com coluna de escopo | Drizzle Kit 0.31 gera SQL inválido para índice com expressão.                                                                           |
| Guarda de lease por `CHECK`         | Expressões com erro em `CASE` podem ser avaliadas antecipadamente pelo SQLite; a violação de `CHECK` só ocorre se a linha for inserida. |
| Ambiente padrão só local            | `wrangler deploy` sem `--env production` não publica nada útil.                                                                         |
