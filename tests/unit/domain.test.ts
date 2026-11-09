import { describe, expect, it } from 'vitest';
import { isGrounded } from '../../src/application/services/advisor';
import { estimateCostMicroUsd } from '../../src/application/services/ai-governor';
import { shouldInterpret } from '../../src/application/services/message-filter';
import {
  computeBudgetStatus,
  newThresholds,
  OVER_LIMIT_THRESHOLD,
  reachedThresholds,
} from '../../src/domain/budgets/budget';
import { inferCategorySlug } from '../../src/domain/finance/categories';
import { expectedDate, findRecurringMatch } from '../../src/domain/finance/recurring';
import type {
  LedgerAccount,
  LedgerContext,
  TransactionDraft,
} from '../../src/domain/finance/transactions';
import {
  amountAppearsInText,
  applySlotAnswer,
  defaultCashAccount,
  defaultCreditCard,
  matchAccount,
  resolveDraft,
} from '../../src/domain/finance/transactions';
import { computeGoalProgress, monthsToReach } from '../../src/domain/goals/goal';
import {
  canAdminister,
  canWrite,
  isAuthorizedSender,
} from '../../src/domain/household/authorization';
import { interpretationJsonSchema } from '../../src/infrastructure/ai/interpretation';

const account = (
  id: string,
  kind: LedgerAccount['kind'],
  extra: Partial<LedgerAccount> = {},
): LedgerAccount => ({
  id,
  name: id,
  normalizedName: id.toLowerCase(),
  kind,
  ownerMemberId: 'f',
  ownership: 'member',
  sharedFallback: false,
  ...extra,
});

const context = (accounts: LedgerAccount[] = []): LedgerContext => ({
  members: [
    { id: 'f', name: 'Felipe' },
    { id: 'j', name: 'Jennifer' },
  ],
  accounts,
  categories: [
    { id: 'c1', slug: 'outros', name: 'Outros', kind: 'expense' },
    { id: 'c2', slug: 'transporte', name: 'Transporte', kind: 'expense' },
    { id: 'c3', slug: 'salario', name: 'Salário', kind: 'income' },
    { id: 'c4', slug: 'outras-receitas', name: 'Outras', kind: 'income' },
  ],
  senderMemberId: 'f',
  today: '2026-11-10',
});

const draft = (overrides: Partial<TransactionDraft> = {}): TransactionDraft => ({
  kind: 'expense',
  amountText: '27',
  description: 'Uber',
  categorySlug: null,
  personText: null,
  isShared: false,
  sourceAccountText: null,
  destinationAccountText: null,
  dateText: null,
  paymentMethod: 'unknown',
  installments: null,
  ...overrides,
});

describe('resolveDraft', () => {
  it('resolve despesa simples sem contas cadastradas', () => {
    const outcome = resolveDraft(draft(), context());
    expect(outcome).toMatchObject({
      status: 'resolved',
      transaction: {
        type: 'expense',
        amountCents: 2700,
        categoryName: 'Transporte',
        sourceAccountId: null,
      },
    });
  });

  it('atribui a outra pessoa pelo nome', () => {
    const outcome = resolveDraft(draft({ personText: 'a Jennifer' }), context());
    expect(outcome).toMatchObject({ status: 'resolved', transaction: { memberId: 'j' } });
  });

  it('resolve pronome para o outro membro do casal', () => {
    const outcome = resolveDraft(draft({ personText: 'minha esposa' }), context());
    expect(outcome).toMatchObject({ status: 'resolved', transaction: { memberId: 'j' } });
  });

  it('recusa pessoa desconhecida', () => {
    expect(resolveDraft(draft({ personText: 'Carlos' }), context()).status).toBe('rejected');
  });

  it('pede valor quando a IA nao extraiu nenhum', () => {
    expect(resolveDraft(draft({ amountText: null }), context())).toMatchObject({
      status: 'needs_input',
      slot: 'amount',
    });
  });

  it('pede confirmacao para valor ambiguo', () => {
    expect(resolveDraft(draft({ amountText: '12.50' }), context())).toMatchObject({
      status: 'needs_input',
      slot: 'amount',
      candidateCents: 1250,
    });
  });

  it('pede o dia quando a data e imprecisa', () => {
    expect(resolveDraft(draft({ dateText: 'semana passada' }), context())).toMatchObject({
      status: 'needs_input',
      slot: 'date',
    });
  });

  it('transferencia vira movimento interno, nunca receita', () => {
    const accounts = [account('Principal', 'checking'), account('Reserva', 'reserve')];
    const outcome = resolveDraft(
      draft({ kind: 'transfer', amountText: '300', destinationAccountText: 'minha reserva' }),
      context(accounts),
    );
    expect(outcome).toMatchObject({
      status: 'resolved',
      transaction: { type: 'transfer', transferKind: 'internal', categoryId: null },
    });
  });

  it('transferencia para cartao vira pagamento de fatura', () => {
    const accounts = [account('Principal', 'checking'), account('Nubank', 'credit_card')];
    const outcome = resolveDraft(
      draft({ kind: 'card_payment', amountText: '850', destinationAccountText: 'nubank' }),
      context(accounts),
    );
    expect(outcome).toMatchObject({
      status: 'resolved',
      transaction: { type: 'transfer', transferKind: 'card_payment' },
    });
  });

  it('nao aceita cartao como origem de transferencia', () => {
    const accounts = [account('Principal', 'checking'), account('Nubank', 'credit_card')];
    const outcome = resolveDraft(
      draft({ kind: 'transfer', sourceAccountText: 'nubank', destinationAccountText: 'principal' }),
      context(accounts),
    );
    expect(outcome.status).toBe('rejected');
  });

  it('compra no credito sem cartao cadastrado e recusada, nao aceita como certa', () => {
    expect(resolveDraft(draft({ paymentMethod: 'credit' }), context()).status).toBe('rejected');
  });

  it('parcelamento exige cartao', () => {
    const accounts = [account('Principal', 'checking')];
    expect(resolveDraft(draft({ installments: 6 }), context(accounts)).status).toBe('rejected');
  });

  it('receita nao entra em cartao', () => {
    const outcome = resolveDraft(
      draft({ kind: 'income', destinationAccountText: 'nubank' }),
      context([account('Nubank', 'credit_card')]),
    );
    expect(outcome.status).toBe('rejected');
  });

  it('pede a conta quando ha varias e nenhuma padrao', () => {
    const accounts = [account('A', 'checking'), account('B', 'checking')];
    expect(resolveDraft(draft(), context(accounts))).toMatchObject({
      status: 'needs_input',
      slot: 'source_account',
    });
  });
});

describe('conta padrao e correspondencia', () => {
  const felipe = { id: 'f', name: 'Felipe' };
  const jennifer = { id: 'j', name: 'Jennifer' };

  it('usa o padrao individual, depois a unica propria, sem cruzar pessoas', () => {
    const accounts = [account('A', 'checking'), account('B', 'checking')];
    expect(defaultCashAccount(felipe, accounts)).toEqual({ status: 'ambiguous' });
    expect(defaultCashAccount({ ...felipe, defaultAccountId: 'B' }, accounts)).toMatchObject({
      account: { id: 'B' },
    });
    expect(defaultCashAccount(felipe, [account('A', 'checking')])).toMatchObject({
      account: { id: 'A' },
    });
    expect(defaultCashAccount(jennifer, [account('A', 'checking')])).toEqual({
      status: 'ambiguous',
    });
    expect(defaultCashAccount({ ...jennifer, defaultAccountId: 'A' }, accounts)).toEqual({
      status: 'ambiguous',
    });
    expect(defaultCashAccount(felipe, [])).toEqual({ status: 'none_configured' });
    expect(
      defaultCashAccount(felipe, [account('R', 'reserve'), account('C', 'credit_card')]),
    ).toEqual({ status: 'none_configured' });
  });

  it('conta do casal so entra como alternativa explicita', () => {
    const shared = { ownerMemberId: null, ownership: 'shared' as const };
    expect(defaultCashAccount(jennifer, [account('C', 'joint', shared)])).toEqual({
      status: 'ambiguous',
    });
    expect(
      defaultCashAccount(jennifer, [account('C', 'joint', { ...shared, sharedFallback: true })]),
    ).toMatchObject({ account: { id: 'C' } });
  });

  it('cartao padrao e de quem comprou; o da outra pessoa nao e escolhido', () => {
    const cards = [account('Roxo', 'credit_card'), account('Azul', 'credit_card')];
    expect(defaultCreditCard(felipe, cards)).toMatchObject({ status: 'ambiguous' });
    expect(defaultCreditCard({ ...felipe, defaultCardId: 'Azul' }, cards)).toMatchObject({
      account: { id: 'Azul' },
    });
    expect(defaultCreditCard(jennifer, [account('Roxo', 'credit_card')])).toMatchObject({
      status: 'ambiguous',
    });
    expect(defaultCreditCard(felipe, [])).toEqual({ status: 'none_configured' });
  });

  it('nome igual: prefere a conta da propria pessoa e separa conta de cartao', () => {
    const accounts = [
      account('Nubank', 'checking', { id: 'nf', normalizedName: 'nubank' }),
      account('Nubank', 'checking', { id: 'nj', normalizedName: 'nubank', ownerMemberId: 'j' }),
      account('Nubank', 'credit_card', { id: 'cf', normalizedName: 'nubank' }),
    ];
    expect(matchAccount('nubank', accounts, { memberId: 'j' })).toMatchObject({
      account: { id: 'nj' },
    });
    expect(matchAccount('cartao nubank', accounts, { memberId: 'f' })).toMatchObject({
      account: { id: 'cf' },
    });
    expect(matchAccount('conta nubank', accounts, { memberId: 'f' })).toMatchObject({
      account: { id: 'nf' },
    });
    expect(matchAccount('nubank', accounts, { memberId: 'f' })).toMatchObject({
      status: 'ambiguous',
    });
  });

  it('entende referencias genericas', () => {
    const accounts = [account('Nubank Felipe', 'checking'), account('Caixinha', 'reserve')];
    expect(matchAccount('minha conta', accounts)).toEqual({ status: 'no_hint' });
    expect(matchAccount('nubank', accounts)).toMatchObject({ status: 'found' });
    expect(matchAccount('minha reserva', accounts)).toMatchObject({ account: { id: 'Caixinha' } });
    expect(matchAccount('itau', accounts)).toEqual({ status: 'not_found' });
  });
});

describe('applySlotAnswer', () => {
  it('confirma candidato com sim', () => {
    expect(applySlotAnswer(draft(), 'amount', 'sim', context(), 1250)?.amountCents).toBe(1250);
  });

  it('nao preenche com resposta sem relacao', () => {
    expect(applySlotAnswer(draft(), 'amount', 'gastei no mercado', context())).toBeNull();
    expect(applySlotAnswer(draft(), 'date', 'banana', context())).toBeNull();
  });
});

describe('amountAppearsInText', () => {
  it('compara numericamente com a mensagem', () => {
    expect(amountAppearsInText('38,50', 'Jennifer gastou 38,50 na farmácia')).toBe(true);
    expect(amountAppearsInText('2 mil', 'paguei 2 mil de entrada')).toBe(true);
    expect(amountAppearsInText('1250', 'foi 1.250,00 reais')).toBe(true);
  });

  it('detecta valor inventado pelo modelo', () => {
    expect(amountAppearsInText('500', 'gastei uma grana no mercado')).toBe(false);
    expect(amountAppearsInText('50', 'gastei 500 no mercado')).toBe(false);
    expect(amountAppearsInText(null, 'gastei 500')).toBe(false);
  });
});

describe('orcamento', () => {
  it('calcula saldo e percentual', () => {
    expect(computeBudgetStatus(25000, 20500)).toEqual({
      limitCents: 25000,
      spentCents: 20500,
      remainingCents: 4500,
      percentUsed: 82,
      isOver: false,
    });
  });

  it('distingue atingir de ultrapassar', () => {
    expect(reachedThresholds(10000, 7999, [80, 100])).toEqual([]);
    expect(reachedThresholds(10000, 8000, [80, 100])).toEqual([80]);
    expect(reachedThresholds(10000, 10000, [80, 100])).toEqual([80, 100]);
    expect(reachedThresholds(10000, 10001, [80, 100])).toEqual([80, 100, OVER_LIMIT_THRESHOLD]);
  });

  it('nao repete limiares ja avisados', () => {
    expect(newThresholds(10000, 9000, [80, 100], [80])).toEqual([]);
    expect(newThresholds(10000, 10500, [80, 100], [80])).toEqual([100, OVER_LIMIT_THRESHOLD]);
  });
});

describe('meta', () => {
  const base = {
    entryCents: 8_000_000,
    additionalCostsCents: 2_000_000,
    deadline: '2027-10-31',
    plannedMonthlyCents: 500_000,
    confirmedCents: 2_500_000,
    confirmedThisMonthCents: 300_000,
  };

  it('calcula progresso, falta e aporte necessario', () => {
    const progress = computeGoalProgress(base, '2026-11-10');
    expect(progress.targetCents).toBe(10_000_000);
    expect(progress.percent).toBe(25);
    expect(progress.remainingCents).toBe(7_500_000);
    expect(progress.monthsToDeadline).toBe(12);
    expect(progress.requiredMonthlyCents).toBe(625_000);
    expect(progress.projectedCompletion).toBe('2028-01');
  });

  it('aporte pretendido nao altera o confirmado', () => {
    const progress = computeGoalProgress({ ...base, plannedMonthlyCents: 9_999_999 }, '2026-11-10');
    expect(progress.confirmedCents).toBe(2_500_000);
  });

  it('nao inventa alvo', () => {
    const progress = computeGoalProgress(
      { ...base, entryCents: null, additionalCostsCents: null },
      '2026-11-10',
    );
    expect(progress.targetCents).toBeNull();
    expect(progress.percent).toBeNull();
    expect(progress.requiredMonthlyCents).toBeNull();
  });

  it('simula mudanca de aporte', () => {
    expect(monthsToReach(600_000, 100_000)).toBe(6);
    expect(monthsToReach(600_000, 150_000)).toBe(4);
    expect(monthsToReach(600_000, 0)).toBeNull();
  });
});

describe('recorrencia', () => {
  it('liga somente com candidato unico e nome inteiro', () => {
    const entries = [
      { id: '1', normalizedDescription: 'aluguel', kind: 'expense' as const, memberId: null },
      { id: '2', normalizedDescription: 'internet', kind: 'expense' as const, memberId: null },
    ];
    expect(findRecurringMatch('Paguei o aluguel', 'expense', 'f', entries)?.id).toBe('1');
    expect(findRecurringMatch('Aluguelzinho', 'expense', 'f', entries)).toBeNull();
    expect(findRecurringMatch('aluguel', 'income', 'f', entries)).toBeNull();
  });

  it('marca dia util como aproximado', () => {
    expect(
      expectedDate({ scheduleType: 'nth_weekday_approx', scheduleValue: 5 }, '2026-11'),
    ).toEqual({
      date: '2026-11-06',
      approximate: true,
    });
    expect(
      expectedDate({ scheduleType: 'monthly_unspecified', scheduleValue: null }, '2026-11'),
    ).toEqual({
      date: null,
      approximate: false,
    });
  });
});

describe('categorias', () => {
  it('infere por palavra inteira', () => {
    expect(inferCategorySlug('Uber para casa', 'expense')).toBe('transporte');
    expect(inferCategorySlug('Farmácia', 'expense')).toBe('farmacia');
    expect(inferCategorySlug('salário', 'income')).toBe('salario');
    expect(inferCategorySlug('barbearia', 'expense')).toBe('outros');
  });
});

describe('autorizacao', () => {
  const active = { role: 'member', status: 'active' } as const;
  it('exige grupo e membro ativo', () => {
    expect(isAuthorizedSender('1', '1', active)).toBe(true);
    expect(isAuthorizedSender('1', '2', active)).toBe(false);
    expect(isAuthorizedSender('1', '1', undefined)).toBe(false);
    expect(isAuthorizedSender('1', '1', { ...active, status: 'revoked' })).toBe(false);
  });

  it('separa leitura, escrita e administracao', () => {
    expect(canWrite({ role: 'viewer', status: 'active' })).toBe(false);
    expect(canAdminister(active)).toBe(false);
    expect(canAdminister({ role: 'admin', status: 'active' })).toBe(true);
    expect(canWrite({ role: 'admin', status: 'revoked' })).toBe(false);
  });
});

describe('filtro antes da IA', () => {
  it('ignora conversa comum', () => {
    expect(shouldInterpret('bom dia amor', false)).toBe(false);
    expect(shouldInterpret('vamos ao cinema?', false)).toBe(false);
  });

  it('deixa passar mensagens possivelmente financeiras', () => {
    expect(shouldInterpret('gastei cinquenta no mercado', false)).toBe(true);
    expect(shouldInterpret('Uber 27', false)).toBe(true);
    expect(shouldInterpret('bom dia', true)).toBe(true);
  });
});

describe('verificacao de fundamentacao', () => {
  const amounts = new Set([12000, 500]);
  const percents = new Set([80]);

  it('aceita apenas numeros presentes nos fatos', () => {
    expect(isGrounded('Vocês gastaram R$ 120,00 e usaram 80%.', amounts, percents)).toBe(true);
    expect(isGrounded('Sem números aqui.', amounts, percents)).toBe(true);
  });

  it('rejeita valor ou percentual inventado', () => {
    expect(isGrounded('Sobram R$ 999,00.', amounts, percents)).toBe(false);
    expect(isGrounded('Vocês usaram 95%.', amounts, percents)).toBe(false);
  });
});

describe('custo e schema de IA', () => {
  it('calcula custo com tokens em cache', () => {
    const cost = estimateCostMicroUsd(
      {
        model: 'm',
        operation: 'interpret',
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 100,
      },
      { m: { input: 0.1, cachedInput: 0.01, output: 0.5 } },
    );
    expect(cost).toBe(Math.ceil(600 * 0.1 + 400 * 0.01 + 100 * 0.5));
  });

  it('gera schema compativel com o modo estrito', () => {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node !== 'object' || node === null) return;
      const object = node as Record<string, unknown>;
      if (object.type === 'object') {
        expect(object.additionalProperties).toBe(false);
        expect([...(object.required as string[])].sort()).toEqual(
          Object.keys(object.properties as object).sort(),
        );
      }
      Object.values(object).forEach(visit);
    };
    const schema = interpretationJsonSchema();
    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(schema.$schema).toBeUndefined();
    visit(schema);
  });
});
