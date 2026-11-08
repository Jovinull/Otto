import type { DateRange, LocalDate, NamedPeriod, Period } from '../../shared/dates';
import {
  addMonths,
  formatShortDate,
  monthName,
  monthRange,
  NAMED_PERIOD_LABEL,
  periodOf,
  resolveNamedPeriod,
  weekRange,
} from '../../shared/dates';
import { formatBRL, percentOf } from '../../shared/money';
import type { Deps, Scope } from '../context';
import type { CategoryTotal, GoalView } from './finance';
import {
  accountBalances,
  cashFlow,
  expensesByCategory,
  expensesByPerson,
  futureInstallments,
  loadBudgetViews,
  loadCommitments,
  loadGoals,
  recentTransactions,
  shortId,
  sumExpenses,
  topExpenses,
} from './finance';

const NO_DATA = 'Ainda não tenho lançamentos nesse período.';

function memberName(scope: Scope, memberId: string): string {
  return scope.members.find((m) => m.id === memberId)?.name ?? 'Membro';
}

function categoryLines(rows: readonly CategoryTotal[], limit = 8): string[] {
  const total = rows.reduce((sum, row) => sum + row.totalCents, 0);
  return rows
    .slice(0, limit)
    .map(
      (row) => `• ${row.name}: ${formatBRL(row.totalCents)} (${percentOf(row.totalCents, total)}%)`,
    );
}

export interface SpendingQuery {
  range: DateRange;
  label: string;
  categoryId?: string | undefined;
  categoryName?: string | undefined;
  memberId?: string | undefined;
}

export async function spendingAnswer(
  deps: Deps,
  scope: Scope,
  query: SpendingQuery,
): Promise<string> {
  const total = await sumExpenses(deps.db, scope.household.id, query.range, {
    categoryId: query.categoryId,
    memberId: query.memberId,
  });
  const who = query.memberId ? memberName(scope, query.memberId) : 'Vocês';
  const what = query.categoryName ? ` com ${query.categoryName}` : '';
  if (total.count === 0) {
    return `Não encontrei gastos${what} ${query.label}${query.memberId ? ` de ${who}` : ''}.`;
  }
  const verb = query.memberId ? 'gastou' : 'gastaram';
  const header = `${who} ${verb} ${formatBRL(total.totalCents)}${what} ${query.label} (${total.count} ${total.count === 1 ? 'lançamento' : 'lançamentos'}).`;
  if (query.categoryId) return header;
  const byCategory = await expensesByCategory(
    deps.db,
    scope.household.id,
    query.range,
    query.memberId,
  );
  return [header, ...categoryLines(byCategory, 5)].join('\n');
}

export async function cashFlowAnswer(
  deps: Deps,
  scope: Scope,
  range: DateRange,
  label: string,
): Promise<string> {
  const flow = await cashFlow(deps.db, scope.household.id, range);
  const lines = [
    `Movimento ${label}:`,
    `Entrou: ${formatBRL(flow.incomeCents)}`,
    `Saiu em despesas: ${formatBRL(flow.expenseCents)}${flow.creditExpenseCents > 0 ? ` (${formatBRL(flow.creditExpenseCents)} no cartão)` : ''}`,
    `Resultado: ${formatBRL(flow.incomeCents - flow.expenseCents)}`,
  ];
  if (flow.internalTransferCents > 0 || flow.cardPaymentCents > 0) {
    lines.push(
      `Fora da conta acima: ${formatBRL(flow.internalTransferCents)} em transferências e ${formatBRL(flow.cardPaymentCents)} em pagamento de fatura.`,
    );
  }
  return lines.join('\n');
}

export async function balancesReport(deps: Deps, scope: Scope): Promise<string> {
  if (scope.accounts.length === 0) {
    return 'Nenhuma conta cadastrada ainda. Use /addconta (veja /ajuda contas).';
  }
  const [balances, goals] = await Promise.all([
    accountBalances(deps.db, scope),
    loadGoals(deps.db, scope.household.id, '9999-12-31'),
  ]);
  const lines = ['Contas (saldos conhecidos pelo Otto, sem integração com o banco):'];
  let knownCash = 0;
  let unknownCount = 0;
  let cardDebt = 0;
  for (const account of balances) {
    if (account.kind === 'credit_card') {
      const balance = account.balanceCents ?? 0;
      cardDebt += Math.max(-balance, 0);
      lines.push(
        balance > 0
          ? `💳 ${account.name}: crédito a favor ${formatBRL(balance)}`
          : `💳 ${account.name}: dívida em aberto ${formatBRL(-balance)}`,
      );
    } else if (account.balanceCents === null) {
      unknownCount += 1;
      lines.push(
        `• ${account.name}: saldo inicial desconhecido; movimentado aqui ${formatBRL(account.netMovementCents)}`,
      );
    } else {
      if (account.kind !== 'reserve') knownCash += account.balanceCents;
      lines.push(
        `${account.kind === 'reserve' ? '🛟' : '•'} ${account.name}: ${formatBRL(account.balanceCents)}`,
      );
    }
  }
  if (unknownCount === 0) {
    lines.push(`Em contas, fora reservas: ${formatBRL(knownCash)}`);
  } else {
    lines.push('Não dá para afirmar o total em contas: falta saldo inicial de alguma conta.');
  }
  if (cardDebt > 0)
    lines.push(`Dívida total nos cartões (inclui parcelas futuras): ${formatBRL(cardDebt)}`);
  const earmarked = goals.reduce((sum, goal) => sum + Math.max(goal.progress.confirmedCents, 0), 0);
  if (earmarked > 0) {
    lines.push(
      `Separado para metas (confirmado): ${formatBRL(earmarked)}. Se está numa dessas contas, não é dinheiro livre.`,
    );
  }
  lines.push(
    'Saldo em conta não é o mesmo que livre para gastar: veja /compromissos e /orcamento.',
  );
  return lines.join('\n');
}

export async function budgetsReport(
  deps: Deps,
  scope: Scope,
  today: LocalDate,
  categoryId?: string,
): Promise<string> {
  const period = periodOf(today);
  const views = await loadBudgetViews(deps.db, scope, period);
  const relevant = categoryId ? views.filter((v) => v.categoryId === categoryId) : views;
  if (relevant.length === 0) {
    return categoryId
      ? 'Essa categoria ainda não tem limite definido. Exemplo: /orcamento delivery 250.'
      : 'Nenhum orçamento definido ainda. Exemplo: /orcamento delivery 250.';
  }
  const lines = [`Orçamento de ${monthName(period)}:`];
  for (const view of relevant) {
    const owner = view.memberId ? ` (${memberName(scope, view.memberId)})` : '';
    const { status } = view;
    const remaining =
      status.remainingCents >= 0
        ? `restam ${formatBRL(status.remainingCents)}`
        : `ultrapassou ${formatBRL(-status.remainingCents)}`;
    lines.push(
      `• ${view.categoryName}${owner}: ${formatBRL(status.spentCents)} de ${formatBRL(status.limitCents)} (${status.percentUsed}%), ${remaining}`,
    );
  }
  return lines.join('\n');
}

function goalLines(goal: GoalView): string[] {
  const { progress } = goal;
  const lines = [`🏠 ${goal.name}`];
  lines.push(`Guardado e confirmado: ${formatBRL(progress.confirmedCents)}`);
  if (progress.targetCents === null) {
    lines.push('Valor-alvo ainda não definido. Use /meta entrada=VALOR custos=VALOR.');
    return lines;
  }
  lines.push(
    `Alvo: ${formatBRL(progress.targetCents)} · Progresso: ${progress.percent}% · Falta: ${formatBRL(progress.remainingCents ?? 0)}`,
  );
  if (progress.requiredMonthlyCents !== null && progress.monthsToDeadline !== null) {
    lines.push(
      `Para o prazo (${monthName(periodOf(goal.deadline!))}): ${formatBRL(progress.requiredMonthlyCents)}/mês por ${progress.monthsToDeadline} meses.`,
    );
  } else if (goal.deadline) {
    lines.push('O prazo informado já passou.');
  }
  if (progress.plannedMonthlyCents !== null) {
    lines.push(
      `Aporte pretendido: ${formatBRL(progress.plannedMonthlyCents)}/mês · Realizado neste mês: ${formatBRL(progress.confirmedThisMonthCents)}`,
    );
    if (progress.projectedCompletion) {
      lines.push(`No ritmo pretendido, chega em ${monthName(progress.projectedCompletion)}.`);
    }
  }
  if (goal.emergencyReserveCents !== null) {
    lines.push(
      `Reserva de emergência (separada da meta): ${formatBRL(goal.emergencyReserveCents)}`,
    );
  }
  lines.push('Projeção ignora rendimentos.');
  return lines;
}

export async function goalReport(deps: Deps, scope: Scope, today: LocalDate): Promise<string> {
  const goals = await loadGoals(deps.db, scope.household.id, today);
  if (goals.length === 0) {
    return 'Meta do apartamento ainda não criada. Comece com: /meta entrada=VALOR custos=VALOR prazo=MM/AAAA aporte=VALOR';
  }
  return goals.flatMap(goalLines).join('\n');
}

export async function billsReport(deps: Deps, scope: Scope, period: Period): Promise<string> {
  const commitments = await loadCommitments(deps.db, scope.household.id, period);
  const open = commitments.filter((c) => c.kind === 'expense' && !c.settled);
  if (open.length === 0) {
    return commitments.some((c) => c.kind === 'expense')
      ? `Todas as contas previstas de ${monthName(period)} estão pagas. ✅`
      : 'Nenhuma conta recorrente cadastrada ainda. Exemplo: /recorrente despesa 1200 dia=5 aluguel';
  }
  const lines = [`Contas em aberto em ${monthName(period)}:`];
  let total = 0;
  let unknown = 0;
  for (const item of open) {
    if (item.amountCents === null) unknown += 1;
    else total += item.amountCents;
    const when = item.expected.date
      ? `${item.expected.approximate ? '~' : ''}${formatShortDate(item.expected.date)}`
      : 'sem data';
    lines.push(
      `• ${item.description}: ${item.amountCents === null ? 'valor variável' : formatBRL(item.amountCents)} (${when})`,
    );
  }
  lines.push(
    `Total previsto: ${formatBRL(total)}${unknown > 0 ? ` + ${unknown} de valor variável` : ''}`,
  );
  if (open.some((c) => c.expected.approximate))
    lines.push('~ data aproximada, sem considerar feriados.');
  return lines.join('\n');
}

export async function incomeForecastReport(
  deps: Deps,
  scope: Scope,
  period: Period,
): Promise<string> {
  const [commitments, flow] = await Promise.all([
    loadCommitments(deps.db, scope.household.id, period),
    cashFlow(deps.db, scope.household.id, monthRange(period)),
  ]);
  const incomes = commitments.filter((c) => c.kind === 'income');
  if (incomes.length === 0) {
    return `Não tenho renda prevista cadastrada para ${monthName(period)}. Use /renda 4200 util=5, por exemplo. Recebido confirmado no mês: ${formatBRL(flow.incomeCents)}.`;
  }
  const expected = incomes.reduce((sum, i) => sum + (i.amountCents ?? 0), 0);
  const lines = [
    `Renda prevista em ${monthName(period)}: ${formatBRL(expected)} (previsão, não é dinheiro em conta)`,
  ];
  for (const income of incomes) {
    const who = income.memberId ? ` (${memberName(scope, income.memberId)})` : '';
    lines.push(
      `• ${income.description}${who}: ${income.amountCents === null ? 'valor variável' : formatBRL(income.amountCents)} ${income.settled ? '✅ recebido' : '⏳ a receber'}`,
    );
  }
  lines.push(`Recebido confirmado no mês: ${formatBRL(flow.incomeCents)}`);
  return lines.join('\n');
}

async function periodReport(
  deps: Deps,
  scope: Scope,
  range: DateRange,
  title: string,
): Promise<string> {
  const flow = await cashFlow(deps.db, scope.household.id, range);
  const byCategory = await expensesByCategory(deps.db, scope.household.id, range);
  const moved = flow.internalTransferCents + flow.cardPaymentCents;
  if (byCategory.length === 0 && flow.incomeCents === 0 && moved === 0) {
    return `${title}\n${NO_DATA}`;
  }
  const lines = [
    title,
    `Entrou: ${formatBRL(flow.incomeCents)} · Saiu: ${formatBRL(flow.expenseCents)}`,
    `Resultado: ${formatBRL(flow.incomeCents - flow.expenseCents)}`,
    ...categoryLines(byCategory),
  ];
  if (moved > 0) {
    lines.push(
      `Movimentações internas (não contam como gasto): ${formatBRL(flow.internalTransferCents)} em transferências, ${formatBRL(flow.cardPaymentCents)} em faturas`,
    );
  }
  const people = await expensesByPerson(deps.db, scope.household.id, range);
  const shared = people.filter((p) => p.isShared).reduce((sum, p) => sum + p.totalCents, 0);
  if (shared > 0) lines.push(`Compartilhado: ${formatBRL(shared)}`);
  return lines.join('\n');
}

/**
 * Observacoes curtas para os fechamentos. Cada frase sai de um numero calculado; sem base
 * comparavel, nao ha comparacao.
 */
export async function periodObservations(
  deps: Deps,
  scope: Scope,
  current: DateRange,
  previous: DateRange,
): Promise<string[]> {
  const [now, before] = await Promise.all([
    expensesByCategory(deps.db, scope.household.id, current),
    expensesByCategory(deps.db, scope.household.id, previous),
  ]);
  const total = now.reduce((sum, row) => sum + row.totalCents, 0);
  if (total === 0) return [];
  const lines: string[] = [];
  const top = now[0]!;
  lines.push(
    `O que mais pesou: ${top.name} (${formatBRL(top.totalCents)}, ${percentOf(top.totalCents, total)}% das despesas).`,
  );
  const previousTotal = before.reduce((sum, row) => sum + row.totalCents, 0);
  if (previousTotal > 0) {
    const rise = now
      .map((row) => {
        const old = before.find((b) => b.categoryId === row.categoryId)?.totalCents ?? 0;
        return { row, old, change: old > 0 ? Math.trunc(((row.totalCents - old) * 100) / old) : 0 };
      })
      .filter((item) => item.old >= 2_000 && item.change >= 20)
      .sort((a, b) => b.change - a.change)[0];
    if (rise) {
      lines.push(
        `${rise.row.name} subiu ${rise.change}% em relação ao período anterior (${formatBRL(rise.old)} → ${formatBRL(rise.row.totalCents)}).`,
      );
    }
    if (total < previousTotal) {
      lines.push(
        `No total, ${formatBRL(previousTotal - total)} a menos que no período anterior${scope.settings.tone === 'friendly' ? '. 👏' : '.'}`,
      );
    }
  }
  return lines;
}

export function weekReport(deps: Deps, scope: Scope, today: LocalDate): Promise<string> {
  const range = weekRange(today);
  return periodReport(
    deps,
    scope,
    range,
    `Semana de ${formatShortDate(range.from)} a ${formatShortDate(range.to)}`,
  );
}

export function monthReport(deps: Deps, scope: Scope, period: Period): Promise<string> {
  return periodReport(deps, scope, monthRange(period), `Resumo de ${monthName(period)}`);
}

export interface ComparisonItem {
  name: string;
  currentCents: number;
  previousCents: number;
  changePercent: number;
}

const MIN_COMPARABLE_CENTS = 2_000;

/**
 * Compara com o mesmo intervalo de dias do mes anterior: um mes em andamento nao pode ser
 * comparado com um mes fechado. Categorias sem base suficiente ficam de fora.
 */
export async function compareMonths(
  deps: Deps,
  scope: Scope,
  period: Period,
  today: LocalDate,
): Promise<{ current: DateRange; previous: DateRange; items: ComparisonItem[] }> {
  const current = monthRange(period);
  const inProgress = periodOf(today) === period;
  const lastDay = inProgress ? today.slice(8) : current.to.slice(8);
  const previousPeriod = addMonths(period, -1);
  const previousFull = monthRange(previousPeriod);
  const previous = {
    from: previousFull.from,
    to:
      `${previousPeriod}-${lastDay}` > previousFull.to
        ? previousFull.to
        : `${previousPeriod}-${lastDay}`,
  };
  const currentRange = inProgress ? { from: current.from, to: today } : current;
  const [nowRows, beforeRows] = await Promise.all([
    expensesByCategory(deps.db, scope.household.id, currentRange),
    expensesByCategory(deps.db, scope.household.id, previous),
  ]);
  const items: ComparisonItem[] = [];
  for (const row of nowRows) {
    const before = beforeRows.find((b) => b.categoryId === row.categoryId);
    if (!before || before.totalCents < MIN_COMPARABLE_CENTS) continue;
    items.push({
      name: row.name,
      currentCents: row.totalCents,
      previousCents: before.totalCents,
      changePercent: Math.trunc(((row.totalCents - before.totalCents) * 100) / before.totalCents),
    });
  }
  items.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
  return { current: currentRange, previous, items };
}

export async function comparisonReport(
  deps: Deps,
  scope: Scope,
  period: Period,
  today: LocalDate,
): Promise<string> {
  const { current, previous, items } = await compareMonths(deps, scope, period, today);
  if (items.length === 0) {
    return 'Ainda não há dados comparáveis com o mês anterior.';
  }
  const lines = [
    `Comparativo: ${formatShortDate(current.from)}–${formatShortDate(current.to)} vs ${formatShortDate(previous.from)}–${formatShortDate(previous.to)}`,
  ];
  for (const item of items.slice(0, 8)) {
    const sign = item.changePercent > 0 ? '+' : '';
    lines.push(
      `• ${item.name}: ${formatBRL(item.previousCents)} → ${formatBRL(item.currentCents)} (${sign}${item.changePercent}%)`,
    );
  }
  return lines.join('\n');
}

export async function peopleReport(deps: Deps, scope: Scope, period: Period): Promise<string> {
  const rows = await expensesByPerson(deps.db, scope.household.id, monthRange(period));
  if (rows.length === 0) return `Sem gastos em ${monthName(period)}.`;
  const lines = [`Quem registrou o quê em ${monthName(period)} (só registro, sem competição 😉):`];
  for (const member of scope.members) {
    const own = rows
      .filter((r) => r.memberId === member.id && !r.isShared)
      .reduce((sum, r) => sum + r.totalCents, 0);
    const shared = rows
      .filter((r) => r.memberId === member.id && r.isShared)
      .reduce((sum, r) => sum + r.totalCents, 0);
    if (own + shared > 0) {
      lines.push(
        `• ${member.name}: individual ${formatBRL(own)} · compartilhado ${formatBRL(shared)}`,
      );
    }
  }
  return lines.join('\n');
}

export async function topExpensesReport(
  deps: Deps,
  scope: Scope,
  range: DateRange,
  label: string,
): Promise<string> {
  const [categories, rows] = await Promise.all([
    expensesByCategory(deps.db, scope.household.id, range),
    topExpenses(deps.db, scope.household.id, range, 5),
  ]);
  if (rows.length === 0) return `Sem despesas ${label}.`;
  return [
    `O que mais pesou ${label}:`,
    ...categoryLines(categories, 5),
    'Maiores lançamentos:',
    ...rows.map(
      (row) =>
        `• ${formatBRL(row.amountCents)} — ${row.description} (${formatShortDate(row.financialDate)})`,
    ),
  ].join('\n');
}

export async function recentReport(deps: Deps, scope: Scope, limit: number): Promise<string> {
  const rows = await recentTransactions(deps.db, scope.household.id, limit);
  if (rows.length === 0) return 'Nenhum lançamento ainda.';
  const icon = { expense: '🔻', income: '🔺', transfer: '🔁' } as const;
  return [
    'Últimos lançamentos:',
    ...rows.map(
      (row) =>
        `${icon[row.type]} ${formatShortDate(row.financialDate)} ${formatBRL(row.amountCents)} — ${row.description} · ${memberName(scope, row.memberId)} · #${shortId(row.id)}`,
    ),
  ].join('\n');
}

export async function commitmentLoad(
  deps: Deps,
  scope: Scope,
  period: Period,
): Promise<{
  expectedIncomeCents: number;
  incomeKnown: boolean;
  openBillsCents: number;
  committedExpenseCents: number;
  futureInstallmentsCents: number;
}> {
  const [commitments, installmentsTotal] = await Promise.all([
    loadCommitments(deps.db, scope.household.id, period),
    futureInstallments(deps.db, scope.household.id),
  ]);
  const incomes = commitments.filter((c) => c.kind === 'income');
  const expenses = commitments.filter((c) => c.kind === 'expense');
  return {
    expectedIncomeCents: incomes.reduce((sum, c) => sum + (c.amountCents ?? 0), 0),
    incomeKnown: incomes.length > 0 && incomes.every((c) => c.amountCents !== null),
    openBillsCents: expenses
      .filter((c) => !c.settled)
      .reduce((sum, c) => sum + (c.amountCents ?? 0), 0),
    committedExpenseCents: expenses.reduce((sum, c) => sum + (c.amountCents ?? 0), 0),
    futureInstallmentsCents: installmentsTotal.totalCents,
  };
}

export function namedPeriodQuery(
  period: NamedPeriod,
  today: LocalDate,
): { range: DateRange; label: string } {
  return { range: resolveNamedPeriod(period, today), label: NAMED_PERIOD_LABEL[period] };
}
