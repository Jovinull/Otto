import { beforeEach, describe, expect, it } from 'vitest';
import { runRecovery } from '../../src/application/jobs/scheduled';
import { HEAD_OF_LINE_MS, processEvent } from '../../src/application/services/inbox';
import { SUBREQUEST_LIMIT } from '../../src/infrastructure/database/metered';
import { RetryableError } from '../../src/shared/errors';
import type { Harness } from '../fixtures/harness';
import {
  CHAT_ID,
  createHarness,
  FELIPE_ID,
  interpretation,
  item,
  STRANGER_ID,
} from '../fixtures/harness';

let h: Harness;

/** Grava um evento como o webhook faria, sem processar (simula caminho rapido perdido). */
async function enqueue(
  updateId: number,
  text: string,
  options: { from?: string; chat?: string; household?: string; receivedAgoMs?: number } = {},
): Promise<string> {
  const [household] = await h.query<{ id: string }>(
    'SELECT id FROM households WHERE telegram_chat_id = ?',
    options.chat ?? CHAT_ID,
  );
  const id = crypto.randomUUID();
  const now = h.now();
  await h.query(
    `INSERT INTO incoming_events (id, update_id, household_id, kind, chat_id, sender_telegram_id, message_id, message_date, payload, status, attempts, next_attempt_at, received_at)
     VALUES (?, ?, ?, 'message', ?, ?, ?, ?, ?, 'received', 0, ?, ?)`,
    id,
    updateId,
    options.household ?? household!.id,
    options.chat ?? CHAT_ID,
    options.from ?? FELIPE_ID,
    updateId,
    Math.floor(now / 1000),
    JSON.stringify({
      text,
      replyToText: null,
      replyToBot: false,
      callbackId: null,
      callbackData: null,
    }),
    now,
    now - (options.receivedAgoMs ?? 0),
  );
  return id;
}

const statusOf = async (id: string) =>
  (await h.query<{ status: string }>('SELECT status FROM incoming_events WHERE id = ?', id))[0]!
    .status;
const limits = async () =>
  (await h.query<{ limit_cents: number }>('SELECT limit_cents FROM budgets'))[0]?.limit_cents;

beforeEach(async () => {
  h = await createHarness();
});

describe('ordem por chat', () => {
  it('evento posterior espera o anterior e e drenado em seguida', async () => {
    const first = await enqueue(500, '/orcamento lazer 100');
    const second = await enqueue(501, '/orcamento lazer 200');

    await processEvent(h.fresh(), second);
    expect(await statusOf(second)).toBe('received');
    expect(await limits()).toBeUndefined();

    await processEvent(h.fresh(), first);
    expect(await statusOf(first)).toBe('processed');
    expect(await statusOf(second)).toBe('processed');
    expect(await limits()).toBe(20000);
  });

  it('correcao enviada logo apos o registro e aplicada ao registro certo', async () => {
    const register = await enqueue(600, '/gasto 27 uber');
    const correction = await enqueue(601, 'Otto, corrige o último para 30');
    h.ai.nextInterpretation = interpretation('correct_transaction', {
      correction: { transaction_ref: null, field: 'amount', value_text: '30' },
    });
    // Os dois caminhos rapidos disputam ao mesmo tempo, na ordem errada.
    await Promise.all([processEvent(h.fresh(), correction), processEvent(h.fresh(), register)]);
    expect(await statusOf(register)).toBe('processed');
    expect(await statusOf(correction)).toBe('processed');
    expect(h.messaging.last()).toContain('Corrigir uber (R$ 27,00');
    await h.say('sim');
    const [row] = await h.query<{ amount_cents: number }>(
      'SELECT amount_cents FROM financial_transactions',
    );
    expect(row!.amount_cents).toBe(3000);
  });

  it('cinco mensagens concorrentes do mesmo chat terminam na ordem do update_id', async () => {
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push(await enqueue(700 + i, `/orcamento lazer ${i}00`));
    await Promise.all([...ids].reverse().map((id) => processEvent(h.fresh(), id)));
    for (let i = 0; i < 6 && (await h.count('incoming_events', "status = 'received'")) > 0; i++) {
      await runRecovery(h.fresh());
    }
    expect(await h.count('incoming_events', "status = 'processed'")).toBe(5);
    expect(await limits()).toBe(50000);
  });

  it('nunca processa dois eventos do mesmo chat ao mesmo tempo', async () => {
    const busy = await enqueue(800, '/gasto 1 a');
    const next = await enqueue(801, '/gasto 2 b');
    await h.query(
      `UPDATE incoming_events SET status = 'processing', lease_until = ?, lease_token = 'outro' WHERE id = ?`,
      h.now() + 60_000,
      busy,
    );
    await processEvent(h.fresh(), next);
    expect(await statusOf(next)).toBe('received');

    // O dono sumiu: depois do lease, o Cron retoma o primeiro e segue para o segundo.
    h.setNow(h.now() + 61_000);
    await runRecovery(h.fresh());
    expect(await statusOf(busy)).toBe('processed');
    expect(await statusOf(next)).toBe('processed');
  });

  it('chats diferentes nao se bloqueiam', async () => {
    await h.query(
      `INSERT INTO households (id, name, telegram_chat_id, created_at) VALUES ('h2', 'Outra', '-5550', 0)`,
    );
    await h.query(
      `INSERT INTO household_members (id, household_id, name, telegram_user_id, role, created_at) VALUES ('m2', 'h2', 'Ana', ?, 'admin', 0)`,
      STRANGER_ID,
    );
    await h.query(
      `INSERT INTO categories (id, household_id, slug, name, kind, nature, created_at) VALUES ('c2', 'h2', 'outros', 'Outros', 'expense', 'other', 0)`,
    );
    const busy = await enqueue(900, '/gasto 1 a');
    await h.query(
      `UPDATE incoming_events SET status = 'processing', lease_until = ?, lease_token = 'x' WHERE id = ?`,
      h.now() + 60_000,
      busy,
    );
    const other = await enqueue(901, '/gasto 5 pão', {
      chat: '-5550',
      from: STRANGER_ID,
      household: 'h2',
    });
    await processEvent(h.fresh(), other);
    expect(await statusOf(other)).toBe('processed');
  });

  it('falha prolongada de um evento bloqueia so pela janela de ordem', async () => {
    h.ai.nextInterpretation = new RetryableError('ai_503');
    await h.say('gastei 27 no uber');
    await h.say('/gasto 10 pão');
    expect(await h.count('financial_transactions')).toBe(0);

    h.setNow(h.now() + HEAD_OF_LINE_MS + 1_000);
    await runRecovery(h.fresh());
    const rows = await h.query<{ description: string }>(
      'SELECT description FROM financial_transactions',
    );
    expect(rows.map((r) => r.description)).toEqual(['pão']);
  });

  it('recuperacao rapida da IA mantem a ordem original', async () => {
    h.ai.nextInterpretation = new RetryableError('ai_503');
    await h.say('gastei 27 no uber');
    await h.say('/gasto 10 pão');
    h.ai.nextInterpretation = interpretation('register_expense', {
      transactions: [item({ amount_text: '27', description: 'uber' })],
    });
    h.setNow(h.now() + 31_000);
    await runRecovery(h.fresh());
    await runRecovery(h.fresh());
    const rows = await h.query<{ description: string }>(
      'SELECT description FROM financial_transactions ORDER BY rowid',
    );
    expect(rows.map((r) => r.description)).toEqual(['uber', 'pão']);
  });

  it('evento atrasado que chega depois de um posterior nao se perde', async () => {
    await h.say('/gasto 2 depois', { updateId: 951 });
    await h.say('/gasto 1 antes', { updateId: 950 });
    expect(await h.count('financial_transactions')).toBe(2);
  });
});

describe('posse do lease', () => {
  it('processamento que perdeu o lease nao grava nada nem reagenda', async () => {
    h.ai.nextInterpretation = interpretation('register_expense', {
      transactions: [item({ amount_text: '27', description: 'uber' })],
    });
    h.ai.duringCall = async () => {
      // Outro worker assume o evento enquanto a IA responde.
      await h.query(`UPDATE incoming_events SET lease_token = 'outro worker'`);
    };
    await h.say('gastei 27 no uber');
    expect(await h.count('financial_transactions')).toBe(0);
    expect(await h.count('outgoing_messages')).toBe(0);
    const [event] = await h.query<{ status: string; lease_token: string }>(
      'SELECT status, lease_token FROM incoming_events',
    );
    expect(event).toEqual({ status: 'processing', lease_token: 'outro worker' });
    expect(await h.count('lease_guard')).toBe(0);

    // O lease do outro expira e o evento e concluido uma unica vez.
    h.ai.duringCall = null;
    h.setNow(h.now() + 61_000);
    await runRecovery(h.fresh());
    expect(await h.count('financial_transactions')).toBe(1);
    expect(h.messaging.sent).toHaveLength(1);
  });

  it('falha ao reagendar sem posse tambem e descartada', async () => {
    h.ai.nextInterpretation = new RetryableError('ai_503');
    h.ai.duringCall = async () => {
      await h.query(`UPDATE incoming_events SET lease_token = 'outro worker'`);
    };
    await h.say('gastei 27 no uber');
    const [event] = await h.query<{ status: string }>('SELECT status FROM incoming_events');
    expect(event!.status).toBe('processing');
    expect(h.messaging.sent).toHaveLength(0);
  });
});

describe('limite de subrequisicoes do plano gratuito', () => {
  async function invocationCost(run: () => Promise<unknown>): Promise<number> {
    await run();
    return h.deps.meter.count;
  }

  it('cada tipo de mensagem cabe numa invocacao', async () => {
    await h.say('/addconta corrente Principal saldo=1000 padrao');
    await h.say('/orcamento transporte 30');
    await h.say('/recorrente despesa 1200 dia=5 aluguel');
    await h.say('/meta entrada=80000 aporte=1000');
    const costs: Record<string, number> = {
      gasto: await invocationCost(() => h.say('/gasto 27 uber')),
      resumo: await invocationCost(() => h.say('/resumo')),
      ia_registro: await invocationCost(async () => {
        h.ai.nextInterpretation = interpretation('register_expense', {
          transactions: [
            item({ amount_text: '20', description: 'almoço' }),
            item({ amount_text: '15', description: 'estacionamento' }),
          ],
        });
        await h.say('gastei 20 no almoço e 15 no estacionamento');
      }),
      ia_compra: await invocationCost(async () => {
        h.ai.nextInterpretation = interpretation('consult_purchase', {
          purchase: { amount_text: '90', description: 'pizza', category_slug: 'delivery' },
        });
        await h.say('podemos pedir pizza de 90?');
      }),
      ia_analise: await invocationCost(async () => {
        h.ai.nextInterpretation = interpretation('request_analysis');
        await h.say('me dá uma análise do mês');
      }),
    };
    for (const cost of Object.values(costs)) expect(cost).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    expect(costs.ia_analise).toBeLessThanOrEqual(3 + 34 + 3);
  });

  it('mantem baixo o numero de chamadas ao banco nos caminhos mais frequentes', async () => {
    // Cada chamada custa de 1 a 2 ms de CPU em producao.
    await h.say('bom dia');
    expect(h.deps.meter.count).toBeLessThanOrEqual(6);

    await runRecovery(h.fresh());
    expect(h.deps.meter.count).toBe(1);
  });

  it('fila acumulada e drenada em varias invocacoes sem estourar o limite', async () => {
    for (let i = 1; i <= 12; i++) {
      await enqueue(1000 + i, `/orcamento lazer ${i}00`, { receivedAgoMs: 1_000 });
    }
    let max = 0;
    for (
      let run = 0;
      run < 15 && (await h.count('incoming_events', "status != 'processed'")) > 0;
      run++
    ) {
      await runRecovery(h.fresh());
      max = Math.max(max, h.deps.meter.count);
    }
    expect(max).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    expect(await h.count('incoming_events', "status = 'processed'")).toBe(12);
    expect(await limits()).toBe(120000);
  });
});
