import { and, desc, eq, isNull } from 'drizzle-orm';
import { computeBudgetStatus, newThresholds } from '../../domain/budgets/budget';
import type { ScheduleType } from '../../domain/finance/recurring';
import type { AccountKind } from '../../domain/finance/transactions';
import type { Stmt } from '../../infrastructure/database/client';
import {
  budgets,
  categories,
  financialAccounts,
  financialGoals,
  goalContributions,
  installmentPlans,
  installments,
  recurringEntries,
} from '../../infrastructure/database/schema';
import type { LocalDate } from '../../shared/dates';
import {
  addMonths,
  dayInPeriod,
  formatDate,
  isValidDate,
  monthName,
  monthRange,
  periodOf,
  resolveDateExpression,
} from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import type { Actor, Deps, Effect } from '../context';
import { replyOnly } from '../context';
import { loadBudgetViews, loadGoals, shortId, sumExpenses } from '../queries/finance';
import {
  alertStatementsFor,
  createPendingStatement,
  confirmationButtons,
} from './record-transactions';
import { auditStatement } from './shared';

export function findMember(actor: Actor, text: string | null) {
  if (!text) return null;
  const first = normalizeText(text).split(' ')[0];
  return actor.scope.members.find((m) => normalizeText(m.name).split(' ')[0] === first) ?? null;
}

export function findCategoryByText(actor: Actor, text: string, kind: 'expense' | 'income') {
  const normalized = normalizeText(text);
  const slug = normalized.replace(/\s+/g, '-');
  const inKind = actor.scope.categories.filter((c) => c.kind === kind);
  return (
    inKind.find((c) => c.slug === slug) ??
    inKind.find((c) => normalizeText(c.name) === normalized) ??
    inKind.find((c) => normalizeText(c.name).includes(normalized)) ??
    null
  );
}

/** Define (ou atualiza) o limite mensal de uma categoria, do geral ou de uma pessoa. */
export async function setBudget(
  deps: Deps,
  actor: Actor,
  categoryText: string | null,
  amountText: string,
  personText: string | null,
): Promise<Effect> {
  const parsed = parseBRL(amountText);
  if (parsed.status !== 'ok') return replyOnly('Não entendi o valor do limite. Exemplo: 250,00.');

  const category = categoryText ? findCategoryByText(actor, categoryText, 'expense') : null;
  if (categoryText && !category) return replyOnly('Categoria não encontrada. Veja /categorias.');
  const member = findMember(actor, personText);
  if (personText && !member) return replyOnly(`Não encontrei "${personText}" no cadastro.`);

  const householdId = actor.scope.household.id;
  const rows = await deps.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.householdId, householdId), isNull(budgets.archivedAt)));
  const existing = rows.find(
    (b) => b.categoryId === (category?.id ?? null) && b.memberId === (member?.id ?? null),
  );
  const now = deps.now();
  const statements: Stmt[] = [];
  let budgetId: string;
  if (existing) {
    budgetId = existing.id;
    statements.push(
      deps.db
        .update(budgets)
        .set({ limitCents: parsed.cents, updatedAt: now })
        .where(and(eq(budgets.id, existing.id), eq(budgets.householdId, householdId))),
      auditStatement(deps, actor, 'budget.updated', 'budget', existing.id, {
        before: { limitCents: existing.limitCents },
        after: { limitCents: parsed.cents },
      }),
    );
  } else {
    budgetId = deps.newId();
    statements.push(
      deps.db.insert(budgets).values({
        id: budgetId,
        householdId,
        categoryId: category?.id ?? null,
        memberId: member?.id ?? null,
        scopeKey: `${category?.id ?? 'all'}:${member?.id ?? 'all'}`,
        limitCents: parsed.cents,
        createdAt: now,
        updatedAt: now,
      }),
      auditStatement(deps, actor, 'budget.created', 'budget', budgetId, {
        after: { limitCents: parsed.cents, categoryId: category?.id ?? null },
      }),
    );
  }

  const label = category?.name ?? 'Geral';
  const owner = member ? ` de ${member.name}` : '';
  const period = periodOf(actor.today);
  const views = await loadBudgetViews(deps.db, actor.scope, period);
  const { totalCents: spent } = await sumExpenses(deps.db, householdId, monthRange(period), {
    categoryId: category?.id,
    memberId: member?.id,
    onlyIndividual: member !== null,
  });
  const notes =
    spent > 0
      ? ` Neste mês já foram ${formatBRL(spent)}; restam ${formatBRL(parsed.cents - spent)}.`
      : '';

  const view = {
    id: budgetId,
    categoryId: category?.id ?? null,
    categoryName: label,
    memberId: member?.id ?? null,
    status: computeBudgetStatus(parsed.cents, spent),
    alerted: existing ? (views.find((v) => v.id === existing.id)?.alerted ?? []) : [],
  };
  const fresh = newThresholds(
    parsed.cents,
    spent,
    actor.scope.settings.budgetAlertThresholds,
    view.alerted,
  );
  statements.push(...alertStatementsFor(deps, view, period, fresh));

  return {
    statements,
    replies: [{ text: `Limite mensal de ${label}${owner}: ${formatBRL(parsed.cents)}.${notes}` }],
  };
}

export interface GoalFields {
  entry?: string | null;
  additionalCosts?: string | null;
  deadline?: string | null;
  plannedMonthly?: string | null;
  emergencyReserve?: string | null;
  initialConfirmed?: string | null;
  notes?: string | null;
}

const APARTMENT_GOAL_NAME = 'Apartamento';

async function apartmentGoal(deps: Deps, householdId: string) {
  const rows = await deps.db
    .select()
    .from(financialGoals)
    .where(
      and(
        eq(financialGoals.householdId, householdId),
        eq(financialGoals.kind, 'apartment'),
        eq(financialGoals.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function parseDeadline(value: string, today: LocalDate): LocalDate | null {
  const monthYear = /^(\d{1,2})[/-](\d{4})$/.exec(value.trim());
  if (monthYear) {
    const month = Number(monthYear[1]);
    if (month < 1 || month > 12) return null;
    const period = `${monthYear[2]}-${String(month).padStart(2, '0')}`;
    return dayInPeriod(period, 31);
  }
  if (isValidDate(value.trim())) return value.trim();
  const months = /^(\d{1,3})\s*(mes|meses)$/.exec(normalizeText(value));
  if (months) return dayInPeriod(addMonths(periodOf(today), Number(months[1])), 31);
  return null;
}

/** Atualiza a meta so com o que foi informado. A meta nunca recebe valores presumidos. */
export async function updateApartmentGoal(
  deps: Deps,
  actor: Actor,
  fields: GoalFields,
): Promise<Effect> {
  const householdId = actor.scope.household.id;
  const now = deps.now();
  const money = (text: string | null | undefined): number | undefined | 'invalid' => {
    if (text === undefined || text === null) return undefined;
    const parsed = parseBRL(text);
    return parsed.status === 'ok' ? parsed.cents : 'invalid';
  };

  const entryCents = money(fields.entry);
  const additionalCostsCents = money(fields.additionalCosts);
  const plannedMonthlyCents = money(fields.plannedMonthly);
  const emergencyReserveCents = money(fields.emergencyReserve);
  const initialCents = money(fields.initialConfirmed);
  if (
    [
      entryCents,
      additionalCostsCents,
      plannedMonthlyCents,
      emergencyReserveCents,
      initialCents,
    ].includes('invalid')
  ) {
    return replyOnly('Algum valor não ficou claro. Exemplo: /meta entrada=80000 prazo=12/2027');
  }
  const deadline =
    fields.deadline === undefined || fields.deadline === null
      ? undefined
      : parseDeadline(fields.deadline, actor.today);
  if (deadline === null) return replyOnly('Prazo inválido. Use MM/AAAA, por exemplo 12/2027.');

  const changes = {
    ...(entryCents !== undefined && { entryCents: entryCents as number }),
    ...(additionalCostsCents !== undefined && {
      additionalCostsCents: additionalCostsCents as number,
    }),
    ...(plannedMonthlyCents !== undefined && {
      plannedMonthlyCents: plannedMonthlyCents as number,
    }),
    ...(emergencyReserveCents !== undefined && {
      emergencyReserveCents: emergencyReserveCents as number,
    }),
    ...(deadline !== undefined && { deadline }),
    ...(fields.notes ? { notes: fields.notes } : {}),
  };

  const existing = await apartmentGoal(deps, householdId);
  const goalId = existing?.id ?? deps.newId();
  const statements: Stmt[] = [];
  if (existing) {
    if (Object.keys(changes).length > 0) {
      statements.push(
        deps.db
          .update(financialGoals)
          .set({ ...changes, updatedAt: now })
          .where(and(eq(financialGoals.id, goalId), eq(financialGoals.householdId, householdId))),
      );
    }
  } else {
    statements.push(
      deps.db.insert(financialGoals).values({
        id: goalId,
        householdId,
        name: APARTMENT_GOAL_NAME,
        kind: 'apartment',
        ...changes,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  statements.push(
    auditStatement(deps, actor, existing ? 'goal.updated' : 'goal.created', 'goal', goalId, {
      after: changes,
    }),
  );

  if (initialCents !== undefined) {
    statements.push(
      deps.db
        .update(goalContributions)
        .set({ status: 'voided' })
        .where(
          and(
            eq(goalContributions.goalId, goalId),
            eq(goalContributions.kind, 'initial'),
            eq(goalContributions.status, 'confirmed'),
          ),
        ),
      deps.db.insert(goalContributions).values({
        id: deps.newId(),
        householdId,
        goalId,
        amountCents: initialCents as number,
        direction: 'in',
        kind: 'initial',
        contributionDate: actor.today,
        memberId: actor.member.id,
        idempotencyKey: `${actor.eventId}:initial`,
        createdAt: now,
      }),
    );
  }

  const lines = ['Meta do apartamento atualizada.'];
  if (entryCents !== undefined) lines.push(`Entrada: ${formatBRL(entryCents as number)}`);
  if (additionalCostsCents !== undefined)
    lines.push(`Custos da compra: ${formatBRL(additionalCostsCents as number)}`);
  if (deadline) lines.push(`Prazo: ${monthName(periodOf(deadline))}`);
  if (plannedMonthlyCents !== undefined)
    lines.push(
      `Aporte pretendido: ${formatBRL(plannedMonthlyCents as number)}/mês (intenção, não conta como guardado)`,
    );
  if (emergencyReserveCents !== undefined)
    lines.push(
      `Reserva de emergência separada: ${formatBRL(emergencyReserveCents as number)} (fora da meta)`,
    );
  if (initialCents !== undefined)
    lines.push(`Já guardado e confirmado: ${formatBRL(initialCents as number)}`);
  return { statements, replies: [{ text: lines.join('\n') }] };
}

export async function addGoalContribution(
  deps: Deps,
  actor: Actor,
  amountText: string,
  direction: 'in' | 'out',
  dateText: string | null,
  idempotencyPrefix: string,
): Promise<Effect> {
  const parsed = parseBRL(amountText);
  if (parsed.status !== 'ok') return replyOnly('Não entendi o valor do aporte. Exemplo: 500,00.');
  const date = resolveDateExpression(dateText ?? '', actor.today);
  if (date.status !== 'ok') return replyOnly('Data inválida. Exemplo: 03/11.');

  const goal = await apartmentGoal(deps, actor.scope.household.id);
  if (!goal)
    return replyOnly('A meta do apartamento ainda não foi criada. Comece com /meta entrada=VALOR.');

  const contributionId = deps.newId();
  const statements: Stmt[] = [
    deps.db.insert(goalContributions).values({
      id: contributionId,
      householdId: actor.scope.household.id,
      goalId: goal.id,
      amountCents: parsed.cents,
      direction,
      kind: 'contribution',
      contributionDate: date.date,
      memberId: actor.member.id,
      idempotencyKey: `${idempotencyPrefix}:goal`,
      createdAt: deps.now(),
    }),
    auditStatement(deps, actor, 'goal_contribution.created', 'goal_contribution', contributionId, {
      after: { amountCents: parsed.cents, direction },
    }),
  ];
  const verb = direction === 'in' ? 'Aporte confirmado' : 'Retirada confirmada';
  const [view] = (await loadGoals(deps.db, actor.scope.household.id, actor.today)).filter(
    (g) => g.id === goal.id,
  );
  const lines = [
    `${verb}: ${formatBRL(parsed.cents)} na meta ${goal.name} (${formatDate(date.date)}).`,
  ];
  if (view) {
    const signed = direction === 'in' ? parsed.cents : -parsed.cents;
    const saved = view.progress.confirmedCents + signed;
    const target = view.progress.targetCents;
    lines.push(
      target
        ? `Agora são ${formatBRL(saved)} de ${formatBRL(target)} (${Math.min(Math.floor((Math.max(saved, 0) * 100) / target), 100)}%).`
        : `Agora são ${formatBRL(saved)} guardados. Defina o alvo com /meta entrada=VALOR.`,
    );
    const planned = view.progress.plannedMonthlyCents;
    const month =
      view.progress.confirmedThisMonthCents +
      (periodOf(date.date) === periodOf(actor.today) ? signed : 0);
    if (planned && direction === 'in') {
      lines.push(
        month >= planned
          ? `Meta do mês batida: ${formatBRL(month)} de ${formatBRL(planned)} pretendidos. 👏`
          : `No mês: ${formatBRL(month)} de ${formatBRL(planned)} pretendidos.`,
      );
    }
  }
  lines.push(`Desfazer: /desfazer_aporte ${shortId(contributionId)}`);
  return { statements, replies: [{ text: lines.join('\n') }] };
}

export async function requestContributionVoid(
  deps: Deps,
  actor: Actor,
  reference: string,
): Promise<Effect> {
  const code = reference.replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{4,36}$/.test(code)) return replyOnly('Código inválido.');
  const rows = await deps.db
    .select()
    .from(goalContributions)
    .where(
      and(
        eq(goalContributions.householdId, actor.scope.household.id),
        eq(goalContributions.status, 'confirmed'),
      ),
    )
    .orderBy(desc(goalContributions.createdAt));
  const matches = rows.filter((r) => shortId(r.id).startsWith(code.slice(0, 6)));
  if (matches.length !== 1) return replyOnly('Aporte não encontrado.');
  const pendingId = deps.newId();
  return {
    statements: [
      createPendingStatement(deps, actor, pendingId, {
        type: 'void_contribution',
        contributionId: matches[0]!.id,
      }),
    ],
    replies: [
      {
        text: `Desfazer o aporte de ${formatBRL(matches[0]!.amountCents)}?`,
        buttons: confirmationButtons(pendingId),
      },
    ],
  };
}

export interface CommitmentInput {
  kind: 'expense' | 'income';
  description: string;
  amountText: string | null;
  scheduleType: ScheduleType;
  scheduleValue: number | null;
  personText: string | null;
  categoryText: string | null;
}

export function normalizedRecurringName(description: string): string {
  return normalizeText(description)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function addCommitment(
  deps: Deps,
  actor: Actor,
  input: CommitmentInput,
): Promise<Effect> {
  let amountCents: number | null = null;
  if (input.amountText !== null) {
    const parsed = parseBRL(input.amountText);
    if (parsed.status !== 'ok') return replyOnly('Não entendi o valor. Exemplo: 1.200,00.');
    amountCents = parsed.cents;
  }
  if (input.scheduleValue !== null) {
    const valid =
      input.scheduleType === 'monthly_day'
        ? input.scheduleValue >= 1 && input.scheduleValue <= 31
        : input.scheduleValue >= 1 && input.scheduleValue <= 23;
    if (!valid) return replyOnly('Dia inválido para a recorrência.');
  }
  const normalized = normalizedRecurringName(input.description);
  if (!normalized) return replyOnly('Dê um nome para o compromisso.');

  const householdId = actor.scope.household.id;
  const person = findMember(actor, input.personText);
  if (input.personText && !person)
    return replyOnly(`Não encontrei "${input.personText}" no cadastro.`);
  const memberId = person?.id ?? (input.kind === 'income' ? actor.member.id : null);

  const category = input.categoryText
    ? findCategoryByText(actor, input.categoryText, input.kind)
    : null;

  const existingRows = await deps.db
    .select()
    .from(recurringEntries)
    .where(
      and(
        eq(recurringEntries.householdId, householdId),
        eq(recurringEntries.active, true),
        eq(recurringEntries.kind, input.kind),
        eq(recurringEntries.normalizedDescription, normalized),
      ),
    );
  const existing = existingRows.find((row) => row.memberId === memberId);

  const values = {
    amountCents,
    scheduleType: input.scheduleType,
    scheduleValue: input.scheduleValue,
    categoryId: category?.id ?? existing?.categoryId ?? null,
  };
  const id = existing?.id ?? deps.newId();
  const statements: Stmt[] = [
    existing
      ? deps.db
          .update(recurringEntries)
          .set(values)
          .where(and(eq(recurringEntries.id, id), eq(recurringEntries.householdId, householdId)))
      : deps.db.insert(recurringEntries).values({
          id,
          householdId,
          kind: input.kind,
          description: input.description,
          normalizedDescription: normalized,
          memberId,
          memberKey: memberId ?? '',
          createdAt: deps.now(),
          ...values,
        }),
    auditStatement(
      deps,
      actor,
      existing ? 'recurring.updated' : 'recurring.created',
      'recurring',
      id,
      {
        after: {
          amountCents,
          scheduleType: input.scheduleType,
          scheduleValue: input.scheduleValue,
        },
      },
    ),
  ];

  const value = amountCents === null ? 'valor variável' : formatBRL(amountCents);
  const when =
    input.scheduleType === 'monthly_day'
      ? `todo dia ${input.scheduleValue}`
      : input.scheduleType === 'nth_weekday_approx'
        ? `por volta do ${input.scheduleValue}º dia útil (sem considerar feriados)`
        : 'todo mês, sem dia definido';
  const nature = input.kind === 'income' ? 'Receita prevista' : 'Compromisso';
  return {
    statements,
    replies: [
      {
        text: `${nature} anotado: ${input.description}, ${value}, ${when}. É previsão: só conta como ${input.kind === 'income' ? 'recebido' : 'pago'} quando vocês me avisarem.`,
      },
    ],
  };
}

export interface NewAccount {
  kind: AccountKind;
  name: string;
  openingText: string | null;
  isDefault: boolean;
  closingDay: number | null;
  dueDay: number | null;
  ownerText: string | null;
}

export async function addAccount(deps: Deps, actor: Actor, input: NewAccount): Promise<Effect> {
  const normalizedName = normalizeText(input.name);
  if (!normalizedName) return replyOnly('Informe o nome da conta.');
  if (actor.scope.accounts.some((a) => a.normalizedName === normalizedName)) {
    return replyOnly('Já existe uma conta com esse nome.');
  }
  let opening: number | null = null;
  if (input.openingText !== null && /^0+(,0{1,2})?$/.test(input.openingText.trim())) {
    // Conta zerada e um saldo conhecido, diferente de saldo desconhecido.
    opening = 0;
  } else if (input.openingText !== null) {
    const parsed = parseBRL(input.openingText);
    if (parsed.status !== 'ok') return replyOnly('Saldo inicial inválido. Exemplo: saldo=1200,50');
    opening = parsed.cents;
  }
  if (input.kind === 'credit_card' && opening !== null) {
    return replyOnly('Cartão não tem saldo inicial. Registre compras e pagamentos normalmente.');
  }
  const owner = findMember(actor, input.ownerText);
  if (input.ownerText && !owner)
    return replyOnly(`Não encontrei "${input.ownerText}" no cadastro.`);

  const householdId = actor.scope.household.id;
  const id = deps.newId();
  const statements: Stmt[] = [];
  if (input.isDefault) {
    statements.push(
      deps.db
        .update(financialAccounts)
        .set({ isDefault: false })
        .where(eq(financialAccounts.householdId, householdId)),
    );
  }
  statements.push(
    deps.db.insert(financialAccounts).values({
      id,
      householdId,
      name: input.name,
      normalizedName,
      kind: input.kind,
      ownerMemberId: owner?.id ?? null,
      openingBalanceCents: opening,
      isDefault: input.isDefault,
      creditClosingDay: input.closingDay,
      creditDueDay: input.dueDay,
      createdAt: deps.now(),
    }),
    auditStatement(deps, actor, 'account.created', 'account', id, { after: { kind: input.kind } }),
  );
  const balance =
    input.kind === 'credit_card'
      ? ''
      : opening === null
        ? ' Saldo inicial não informado: mostro só o movimentado aqui, nunca um saldo real.'
        : ` Saldo inicial: ${formatBRL(opening)}.`;
  return { statements, replies: [{ text: `Conta criada: ${input.name}.${balance}` }] };
}

export function addCategory(
  deps: Deps,
  actor: Actor,
  name: string,
  nature: 'essential' | 'discretionary' | 'other',
): Effect {
  const slug = normalizeText(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return replyOnly('Nome inválido.');
  if (actor.scope.categories.some((c) => c.slug === slug))
    return replyOnly('Essa categoria já existe.');
  const id = deps.newId();
  return {
    statements: [
      deps.db.insert(categories).values({
        id,
        householdId: actor.scope.household.id,
        slug,
        name,
        kind: 'expense',
        nature,
        createdAt: deps.now(),
      }),
      auditStatement(deps, actor, 'category.created', 'category', id, { after: { slug, nature } }),
    ],
    replies: [{ text: `Categoria criada: ${name} (código ${slug}).` }],
  };
}

async function findPlan(deps: Deps, actor: Actor, reference: string) {
  const code = reference.replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{4,12}$/.test(code)) return null;
  const rows = await deps.db
    .select()
    .from(installmentPlans)
    .where(
      and(
        eq(installmentPlans.householdId, actor.scope.household.id),
        eq(installmentPlans.status, 'active'),
      ),
    );
  const matches = rows.filter((plan) => shortId(plan.transactionId).startsWith(code));
  return matches.length === 1 ? matches[0]! : null;
}

export async function setInstallmentFirstDue(
  deps: Deps,
  actor: Actor,
  reference: string,
  dateText: string,
): Promise<Effect> {
  const plan = await findPlan(deps, actor, reference);
  if (!plan) return replyOnly('Parcelamento não encontrado. Veja /parcelas.');
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(dateText.trim());
  const date = match
    ? `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`
    : null;
  if (!date || !isValidDate(date)) return replyOnly('Use a data completa: DD/MM/AAAA.');

  const rows = await deps.db
    .select()
    .from(installments)
    .where(eq(installments.planId, plan.id))
    .orderBy(installments.sequence);
  const day = Number(date.slice(8));
  const statements: Stmt[] = [
    deps.db
      .update(installmentPlans)
      .set({ firstDueDate: date })
      .where(eq(installmentPlans.id, plan.id)),
    ...rows.map((row, i) =>
      deps.db
        .update(installments)
        .set({ dueDate: dayInPeriod(addMonths(periodOf(date), i), day) })
        .where(eq(installments.id, row.id)),
    ),
    auditStatement(deps, actor, 'installment_plan.first_due_set', 'installment_plan', plan.id, {
      after: { firstDueDate: date },
    }),
  ];
  return {
    statements,
    replies: [{ text: `Primeiro vencimento: ${formatDate(date)}. Cronograma atualizado.` }],
  };
}

export async function markNextInstallmentPaid(
  deps: Deps,
  actor: Actor,
  reference: string,
): Promise<Effect> {
  const plan = await findPlan(deps, actor, reference);
  if (!plan) return replyOnly('Parcelamento não encontrado. Veja /parcelas.');
  const rows = await deps.db
    .select()
    .from(installments)
    .where(and(eq(installments.planId, plan.id), eq(installments.status, 'scheduled')))
    .orderBy(installments.sequence)
    .limit(1);
  const next = rows[0];
  if (!next) return replyOnly('Todas as parcelas já estão quitadas.');
  return {
    statements: [
      deps.db
        .update(installments)
        .set({ status: 'paid', paidAt: deps.now() })
        .where(eq(installments.id, next.id)),
      auditStatement(deps, actor, 'installment.paid', 'installment', next.id, {
        after: { sequence: next.sequence },
      }),
    ],
    replies: [
      {
        text: `Parcela ${next.sequence}/${plan.installmentCount} (${formatBRL(next.amountCents)}) marcada como quitada. Isso não movimenta conta: o pagamento em si é o da fatura.`,
      },
    ],
  };
}
