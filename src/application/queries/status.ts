import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { matchAccount } from '../../domain/finance/transactions';
import { computeAvailability } from '../../domain/goals/goal';
import { parseMemberPreferences } from '../../domain/household/settings';
import { financialTransactions as tx } from '../../infrastructure/database/schema';
import type { LocalDate } from '../../shared/dates';
import { formatShortDate, monthName, monthRange, periodOf } from '../../shared/dates';
import { formatBRL } from '../../shared/money';
import type { Account, Actor, Deps, Member, Scope } from '../context';
import type { CardStatement } from './cards';
import { cardStatement } from './cards';
import type { AccountBalance, CommitmentView, GoalView } from './finance';
import { accountBalances, loadCommitments, loadGoals } from './finance';

interface MonthRow {
  memberId: string;
  type: string;
  isShared: boolean;
  amountCents: number;
}

interface StatusData {
  positions: AccountBalance[];
  goals: GoalView[];
  commitments: CommitmentView[];
  statements: Map<string, CardStatement>;
  rows: MonthRow[];
}

async function loadStatusData(
  deps: Deps,
  scope: Scope,
  today: LocalDate,
  cards: readonly Account[],
): Promise<StatusData> {
  const period = periodOf(today);
  const range = monthRange(period);
  const [positions, goals, commitments, rows, ...cardStatements] = await Promise.all([
    accountBalances(deps.db, scope),
    loadGoals(deps.db, scope.household.id, today),
    loadCommitments(deps.db, scope.household.id, period),
    deps.db
      .select({
        memberId: tx.memberId,
        type: tx.type,
        isShared: tx.isShared,
        amountCents: tx.amountCents,
      })
      .from(tx)
      .where(
        and(
          eq(tx.householdId, scope.household.id),
          eq(tx.status, 'confirmed'),
          inArray(tx.type, ['expense', 'income']),
          gte(tx.financialDate, range.from),
          lte(tx.financialDate, range.to),
        ),
      ),
    ...cards.map((card) => cardStatement(deps.db, scope, card, today)),
  ]);
  const statements = new Map<string, CardStatement>();
  for (const statement of cardStatements) {
    if (statement) statements.set(statement.card.id, statement);
  }
  return { positions, goals, commitments, rows, statements };
}

interface CardSummary {
  line: string;
  openCents: number;
  totalDebtCents: number;
}

function summarizeCard(
  card: Account,
  position: AccountBalance | undefined,
  statement: CardStatement | undefined,
  today: LocalDate,
  isDefault = false,
): CardSummary {
  const star = isDefault ? ' ⭐' : '';
  if (!statement) {
    const debt = Math.max(-(position?.balanceCents ?? 0), 0);
    return {
      line: `• ${card.name}${star}: dívida ${formatBRL(debt)} (sem dias de fechamento e vencimento cadastrados)`,
      openCents: debt,
      totalDebtCents: debt,
    };
  }
  const due = statement.invoices.filter((i) => i.status !== 'future' && i.remainingCents > 0);
  const openCents = due.reduce((sum, i) => sum + i.remainingCents, 0);
  const totalDebtCents = statement.invoices.reduce((sum, i) => sum + i.remainingCents, 0);
  const next = due[0];
  const future = totalDebtCents - openCents;
  const parts = [
    next
      ? `a pagar ${formatBRL(openCents)}, ${next.dueDate < today ? 'venceu' : 'vence'} em ${formatShortDate(next.dueDate)}`
      : 'nada a pagar agora',
  ];
  if (future > 0) parts.push(`parcelas futuras ${formatBRL(future)}`);
  if (card.creditLimitCents !== null) parts.push(`limite ${formatBRL(card.creditLimitCents)}`);
  if (card.creditAvailableCents !== null) {
    parts.push(`disponível informado ${formatBRL(card.creditAvailableCents)}`);
  }
  return { line: `• ${card.name}${star}: ${parts.join(' · ')}`, openCents, totalDebtCents };
}

interface CashSummary {
  lines: string[];
  knownCents: number;
  freeCents: number;
  allocatedCents: number;
  unknown: string[];
}

function summarizeCash(
  positions: readonly AccountBalance[],
  labelOf?: (a: AccountBalance) => string,
) {
  const summary: CashSummary = {
    lines: [],
    knownCents: 0,
    freeCents: 0,
    allocatedCents: 0,
    unknown: [],
  };
  for (const position of positions) {
    const label = labelOf ? labelOf(position) : '';
    const { freeCents } = computeAvailability(position);
    if (position.balanceCents === null || freeCents === null) {
      summary.unknown.push(position.name);
      summary.lines.push(`• ${position.name}${label}: saldo desconhecido`);
      continue;
    }
    summary.knownCents += position.balanceCents;
    summary.freeCents += freeCents;
    summary.allocatedCents += position.allocatedCents;
    summary.lines.push(
      `• ${position.name}${label}: ${formatBRL(position.balanceCents)}${position.allocatedCents > 0 ? ` · reservado ${formatBRL(position.allocatedCents)} · livre ${formatBRL(freeCents)}` : ''}`,
    );
  }
  return summary;
}

function goalLine(goal: GoalView): string {
  const { progress } = goal;
  return progress.targetCents === null
    ? `• ${goal.name}: ${formatBRL(progress.confirmedCents)} reservados, sem valor-alvo`
    : `• ${goal.name}: ${formatBRL(progress.confirmedCents)} de ${formatBRL(progress.targetCents)} (${progress.percent}%)`;
}

const sum = (rows: readonly MonthRow[]) => rows.reduce((total, r) => total + r.amountCents, 0);
const forecast = (items: readonly CommitmentView[]) =>
  items.reduce((total, c) => total + (c.frequency === 'monthly' ? (c.amountCents ?? 0) : 0), 0);

function potentialLines(
  cash: CashSummary,
  billsCents: number,
  cardsCents: number,
  scopeNote: string,
): string[] {
  const potential = cash.freeCents - billsCents - cardsCents;
  const lines = [
    `🧮 Potencialmente livre: ${formatBRL(potential)}`,
    `Conta feita: ${formatBRL(cash.freeCents)} livres em contas − ${formatBRL(billsCents)} de contas a pagar − ${formatBRL(cardsCents)} de cartão a pagar. ${scopeNote} Não prevê gastos que ainda vão acontecer.`,
  ];
  if (cash.unknown.length > 0) {
    lines.push(`Fora da conta, sem saldo conhecido: ${cash.unknown.join(', ')}.`);
  }
  return lines;
}

function pendingBills(items: readonly CommitmentView[]): number {
  return items
    .filter((c) => c.kind === 'expense' && !c.settled)
    .reduce((total, c) => total + (c.amountCents ?? 0), 0);
}

export function resolveMember(actor: Actor, text: string | null): Member | string {
  if (!text) return actor.member;
  const wanted = text.trim().toLowerCase();
  return (
    actor.scope.members.find((m) => m.name.toLowerCase() === wanted) ??
    `Não encontrei "${text}" no cadastro.`
  );
}

export async function personalStatus(deps: Deps, actor: Actor, member: Member): Promise<string> {
  const { scope, today } = actor;
  const cards = scope.accounts.filter(
    (a) => a.kind === 'credit_card' && a.ownerMemberId === member.id,
  );
  const data = await loadStatusData(deps, scope, today, cards);
  const preferences = parseMemberPreferences(member.preferences);
  const incomes = data.commitments.filter((c) => c.kind === 'income' && c.memberId === member.id);
  const mine = data.rows.filter((r) => r.memberId === member.id);
  const income = mine.filter((r) => r.type === 'income');
  const expenses = mine.filter((r) => r.type === 'expense');
  const own = data.positions.filter(
    (p) => p.kind !== 'credit_card' && p.ownerMemberId === member.id,
  );
  const shared = data.positions.filter((p) => p.kind !== 'credit_card' && p.ownership === 'shared');
  const cash = summarizeCash(own);
  const cardLines = cards.map((card) =>
    summarizeCard(
      card,
      data.positions.find((p) => p.id === card.id),
      data.statements.get(card.id),
      today,
      preferences.defaultCardId === card.id,
    ),
  );
  const bills = pendingBills(data.commitments.filter((c) => c.memberId === member.id));
  const goals = data.goals.filter((g) => g.ownerMemberId === member.id || g.ownerMemberId === null);
  const cardsDue = cardLines.reduce((total, c) => total + c.openCents, 0);

  const lines = [
    `Status de ${member.name} · ${monthName(periodOf(today))}`,
    `💰 Renda prevista ${formatBRL(forecast(incomes))} · recebida ${formatBRL(sum(income))}`,
    `💸 Gastos individuais ${formatBRL(sum(expenses.filter((r) => !r.isShared)))} · pagos para o casal ${formatBRL(sum(expenses.filter((r) => r.isShared)))}`,
  ];
  if (own.length > 0) lines.push('', '🏦 Contas', ...cash.lines);
  if (shared.length > 0) {
    lines.push('', 'Contas do casal (fora da conta abaixo):');
    lines.push(...summarizeCash(shared).lines);
  }
  if (cardLines.length > 0) lines.push('', '💳 Cartões', ...cardLines.map((c) => c.line));
  if (bills > 0) lines.push('', `📌 Contas a pagar no mês: ${formatBRL(bills)}`);
  if (goals.length > 0) lines.push('', '🎯 Metas', ...goals.map(goalLine));
  if (own.length > 0) {
    lines.push(
      '',
      ...potentialLines(
        cash,
        bills,
        cardsDue,
        'Só contas e cartões de quem consulta; contas compartilhadas ficam de fora.',
      ),
    );
  }
  return lines.join('\n');
}

export async function coupleStatus(deps: Deps, actor: Actor): Promise<string> {
  const { scope, today } = actor;
  const cards = scope.accounts.filter((a) => a.kind === 'credit_card');
  const data = await loadStatusData(deps, scope, today, cards);
  const memberName = (id: string | null) => scope.members.find((m) => m.id === id)?.name;
  const cash = summarizeCash(
    data.positions.filter((p) => p.kind !== 'credit_card'),
    (p) => ` (${memberName(p.ownerMemberId) ?? 'casal'})`,
  );
  const cardLines = cards.map((card) =>
    summarizeCard(
      card,
      data.positions.find((p) => p.id === card.id),
      data.statements.get(card.id),
      today,
    ),
  );
  const bills = pendingBills(data.commitments);
  const cardsDue = cardLines.reduce((total, c) => total + c.openCents, 0);
  const cardsTotal = cardLines.reduce((total, c) => total + c.totalDebtCents, 0);
  const expenses = data.rows.filter((r) => r.type === 'expense');
  const reserved = data.goals.reduce((t, g) => t + Math.max(g.progress.confirmedCents, 0), 0);

  const lines = [`Status do casal · ${monthName(periodOf(today))}`];
  for (const member of scope.members.filter((m) => m.status === 'active')) {
    const incomes = data.commitments.filter((c) => c.kind === 'income' && c.memberId === member.id);
    const received = data.rows.filter((r) => r.type === 'income' && r.memberId === member.id);
    const own = expenses.filter((r) => r.memberId === member.id && !r.isShared);
    lines.push(
      `💰 ${member.name}: renda prevista ${formatBRL(forecast(incomes))} · recebida ${formatBRL(sum(received))} · gastos individuais ${formatBRL(sum(own))}`,
    );
  }
  lines.push(`🤝 Gastos compartilhados: ${formatBRL(sum(expenses.filter((r) => r.isShared)))}`);
  lines.push('', '🏦 Contas', ...cash.lines);
  if (cash.unknown.length === 0) lines.push(`Patrimônio em contas: ${formatBRL(cash.knownCents)}`);
  else lines.push(`Conhecido em contas: ${formatBRL(cash.knownCents)} (faltam saldos)`);
  if (cardLines.length > 0) {
    lines.push('', '💳 Cartões', ...cardLines.map((c) => c.line));
    lines.push(`Dívida total nos cartões: ${formatBRL(cardsTotal)}`);
  }
  if (bills > 0) lines.push('', `📌 Contas a pagar no mês: ${formatBRL(bills)}`);
  if (data.goals.length > 0) {
    lines.push('', `🎯 Metas (reservado ${formatBRL(reserved)})`, ...data.goals.map(goalLine));
  }
  lines.push('', ...potentialLines(cash, bills, cardsDue, 'Considera todas as contas do casal.'));
  return lines.join('\n');
}

/** Contas e cartoes da pessoa, com os padroes marcados. */
export async function myAccountsReport(deps: Deps, actor: Actor, member: Member): Promise<string> {
  const positions = await accountBalances(deps.db, actor.scope);
  const preferences = parseMemberPreferences(member.preferences);
  const own = positions.filter((p) => p.ownerMemberId === member.id || p.ownership === 'shared');
  if (own.length === 0) {
    return `${member.name} ainda não tem contas. Use /addconta corrente Nome saldo=1000.`;
  }
  const lines = own.map((p) => {
    const isDefault = p.id === preferences.defaultAccountId || p.id === preferences.defaultCardId;
    const suffix = p.ownership === 'shared' ? ' (casal)' : '';
    return `${p.kind === 'credit_card' ? '💳' : '🏦'} ${p.name}${suffix}${isDefault ? ' ⭐ padrão' : ''}`;
  });
  return [`Contas de ${member.name}:`, ...lines].join('\n');
}

export async function myBalancesReport(deps: Deps, actor: Actor, member: Member): Promise<string> {
  const positions = await accountBalances(deps.db, actor.scope);
  const own = positions.filter((p) => p.kind !== 'credit_card' && p.ownerMemberId === member.id);
  if (own.length === 0) return `${member.name} ainda não tem contas próprias.`;
  const cash = summarizeCash(own);
  const lines = [`Saldos de ${member.name}:`, ...cash.lines];
  if (cash.unknown.length === 0) lines.push(`Total: ${formatBRL(cash.knownCents)}`);
  else lines.push(`Total conhecido: ${formatBRL(cash.knownCents)} (faltam saldos)`);
  return lines.join('\n');
}

export async function myCardsReport(deps: Deps, actor: Actor, member: Member): Promise<string> {
  const { scope, today } = actor;
  const cards = scope.accounts.filter(
    (a) => a.kind === 'credit_card' && a.ownerMemberId === member.id,
  );
  if (cards.length === 0) return `${member.name} ainda não tem cartões.`;
  const preferences = parseMemberPreferences(member.preferences);
  const [positions, ...statements] = await Promise.all([
    accountBalances(deps.db, scope),
    ...cards.map((card) => cardStatement(deps.db, scope, card, today)),
  ]);
  const lines = cards.map((card, index) => {
    const statement = statements[index] as CardStatement | null;
    return summarizeCard(
      card,
      positions.find((p) => p.id === card.id),
      statement ?? undefined,
      today,
      preferences.defaultCardId === card.id,
    ).line;
  });
  return [`Cartões de ${member.name}:`, ...lines].join('\n');
}

export async function myGoalsReport(deps: Deps, actor: Actor, member: Member): Promise<string> {
  const goals = (await loadGoals(deps.db, actor.scope.household.id, actor.today)).filter(
    (g) => g.ownerMemberId === member.id || g.ownerMemberId === null,
  );
  if (goals.length === 0) return 'Nenhuma meta ainda. Crie com /meta criar NOME valor=VALOR.';
  return [`Metas de ${member.name} e do casal:`, ...goals.map(goalLine)].join('\n');
}

export async function incomeSourcesReport(deps: Deps, actor: Actor): Promise<string> {
  const { scope, today } = actor;
  const commitments = (await loadCommitments(deps.db, scope.household.id, periodOf(today))).filter(
    (c) => c.kind === 'income',
  );
  if (commitments.length === 0) {
    return 'Nenhuma renda cadastrada. Exemplo: /renda 4000 dia=5 @Nubank';
  }
  const lines = ['Rendas cadastradas (previsão, não é dinheiro em conta):'];
  for (const income of commitments) {
    const who = scope.members.find((m) => m.id === income.memberId)?.name ?? 'Casal';
    const account = scope.accounts.find((a) => a.id === income.accountId)?.name;
    const value = income.amountCents === null ? 'valor variável' : formatBRL(income.amountCents);
    const when =
      income.frequency === 'irregular'
        ? 'sem data fixa'
        : income.expected.date
          ? `previsto ${formatShortDate(income.expected.date)}`
          : 'sem dia definido';
    lines.push(
      `• ${income.description} (${who}): ${value} · ${when}${account ? ` · ${account}` : ''} · ${income.settled ? '✅ recebido' : '⏳ a receber'}`,
    );
  }
  lines.push('Quando cair: /recebi NOME [VALOR].');
  return lines.join('\n');
}

/** Livre numa conta: saldo menos o que esta reservado para metas. */
export async function accountFreeReport(
  deps: Deps,
  actor: Actor,
  accountText: string,
): Promise<string> {
  const accounts = actor.scope.accounts.filter((a) => a.kind !== 'credit_card');
  const match = matchAccount(accountText.replaceAll('_', ' '), accounts, {
    memberId: actor.member.id,
  });
  if (match.status === 'ambiguous') {
    return `Qual delas? ${match.options.map((a) => a.name).join(', ')}.`;
  }
  if (match.status !== 'found') return `Não achei a conta "${accountText}". Veja /contas.`;
  const position = (await accountBalances(deps.db, actor.scope)).find(
    (p) => p.id === match.account.id,
  );
  if (!position) return 'Conta não encontrada.';
  const reservedText = position.allocations
    .map((a) => `${a.goalName} ${formatBRL(a.cents)}`)
    .join(' · ');
  if (position.balanceCents === null) {
    return `${position.name}: saldo desconhecido, então não sei quanto está livre. Informe com /saldo ${position.name} VALOR.${reservedText ? ` Reservado: ${reservedText}.` : ''}`;
  }
  const { freeCents } = computeAvailability(position);
  return [
    `${position.name}: saldo ${formatBRL(position.balanceCents)}`,
    reservedText ? `Reservado: ${reservedText}` : 'Nada reservado para metas.',
    `Livre de metas: ${formatBRL(freeCents!)} (ainda não desconta contas a pagar; veja /statuspessoal).`,
  ].join('\n');
}
