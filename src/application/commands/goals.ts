import { and, eq } from 'drizzle-orm';
import type { ResolvedTransaction } from '../../domain/finance/transactions';
import { matchAccount } from '../../domain/finance/transactions';
import { computeAvailability } from '../../domain/goals/goal';
import { parseMemberPreferences } from '../../domain/household/settings';
import type { Stmt } from '../../infrastructure/database/client';
import { financialGoals, goalContributions } from '../../infrastructure/database/schema';
import type { LocalDate } from '../../shared/dates';
import { formatDate, monthName, periodOf, resolveDateExpression } from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import type { Account, Actor, Deps, Effect } from '../context';
import { replyOnly } from '../context';
import type { AccountBalance, GoalView } from '../queries/finance';
import { accountBalances, loadGoals, shortId } from '../queries/finance';
import { addAccount, findMember, parseDeadline } from './planning';
import {
  confirmationButtons,
  createPendingStatement,
  statementsForTransaction,
} from './record-transactions';
import { auditStatement } from './shared';

const NAME_NOISE = new Set(['meta', 'objetivo', 'do', 'da', 'de', 'para', 'pra', 'pro', 'o', 'a']);

const MAX_GOAL_NAME = 60;

/** So a meta da casa e especial; "Apartamento da praia" e uma meta comum. */
export function isApartmentName(name: string): boolean {
  return ['apartamento', 'entrada do apartamento', 'meta do apartamento'].includes(
    normalizeText(name),
  );
}

const meaningfulWords = (text: string): string[] =>
  normalizeText(text)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter((w) => w && !NAME_NOISE.has(w));

export type GoalLookup = { goal: GoalView } | { error: string };

/** Procura a meta pelo nome; sem nome, so a do apartamento ou a unica existente. */
export function findGoal(goals: readonly GoalView[], text: string | null): GoalLookup {
  if (goals.length === 0) {
    return { error: 'Ainda não há metas. Crie com /meta criar NOME valor=VALOR.' };
  }
  const names = goals.map((g) => g.name).join(', ');
  if (!text) {
    const apartment = goals.find((g) => g.kind === 'apartment');
    if (apartment) return { goal: apartment };
    if (goals.length === 1) return { goal: goals[0]! };
    return { error: `Para qual meta? Opções: ${names}.` };
  }
  const words = meaningfulWords(text);
  if (words.length === 0) return findGoal(goals, null);
  const exact = goals.filter((g) => meaningfulWords(g.name).join(' ') === words.join(' '));
  const matches =
    exact.length > 0
      ? exact
      : goals.filter((g) => {
          const name = meaningfulWords(g.name);
          return words.every((w) => name.includes(w)) || name.every((w) => words.includes(w));
        });
  if (matches.length === 1) return { goal: matches[0]! };
  if (matches.length > 1) {
    return {
      error: `Encontrei mais de uma: ${matches.map((g) => g.name).join(', ')}. Qual delas?`,
    };
  }
  return { error: `Não achei a meta "${text}". Metas: ${names}.` };
}

const money = (text: string | null | undefined): number | undefined | 'invalid' => {
  if (text === null || text === undefined) return undefined;
  const parsed = parseBRL(text);
  return parsed.status === 'ok' ? parsed.cents : 'invalid';
};

export interface GoalDefinition {
  name: string;
  targetText?: string | null;
  deadlineText?: string | null;
  plannedText?: string | null;
  ownerText?: string | null;
  notes?: string | null;
}

/** Cria uma meta so com o que foi informado: prazo e aporte nunca sao presumidos. */
export async function createGoal(deps: Deps, actor: Actor, input: GoalDefinition): Promise<Effect> {
  const name = input.name.replaceAll('_', ' ').trim();
  const normalizedName = normalizeText(name);
  if (!normalizedName) return replyOnly('Dê um nome para a meta.');
  if (name.length > MAX_GOAL_NAME) return replyOnly('Nome muito longo. Use até 60 letras.');
  const target = money(input.targetText);
  const planned = money(input.plannedText);
  if (target === 'invalid' || planned === 'invalid') {
    return replyOnly('Valor inválido. Exemplo: /meta criar Viagem valor=8000');
  }
  const deadline = input.deadlineText ? parseDeadline(input.deadlineText, actor.today) : undefined;
  if (deadline === null) return replyOnly('Prazo inválido. Use MM/AAAA, por exemplo 12/2027.');
  const owner =
    input.ownerText && normalizeText(input.ownerText) !== 'casal'
      ? findMember(actor, input.ownerText)
      : null;
  if (input.ownerText && normalizeText(input.ownerText) !== 'casal' && !owner) {
    return replyOnly(`Não encontrei "${input.ownerText}" no cadastro.`);
  }

  const goals = await loadGoals(deps.db, actor.scope.household.id, actor.today);
  if (goals.some((g) => normalizeText(g.name) === normalizedName)) {
    return replyOnly(`Já existe a meta ${name}. Para mudar: /meta editar ${name} valor=VALOR`);
  }

  const isApartment = isApartmentName(name);
  const existingApartment = goals.find((g) => g.kind === 'apartment');
  if (isApartment && existingApartment) {
    return replyOnly(
      `A meta ${existingApartment.name} já existe. Para mudar o valor: /meta entrada=VALOR`,
    );
  }

  const id = deps.newId();
  const now = deps.now();
  return {
    statements: [
      deps.db.insert(financialGoals).values({
        id,
        householdId: actor.scope.household.id,
        name,
        normalizedName,
        kind: isApartment ? 'apartment' : 'general',
        ownerMemberId: owner?.id ?? null,
        // A meta do apartamento guarda o alvo em entrada + custos.
        targetCents: isApartment ? null : (target ?? null),
        entryCents: isApartment ? (target ?? null) : null,
        deadline: deadline ?? null,
        plannedMonthlyCents: planned ?? null,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      }),
      auditStatement(deps, actor, 'goal.created', 'goal', id, {
        after: { targetCents: target ?? null, plannedMonthlyCents: planned ?? null },
      }),
    ],
    replies: [
      {
        text: [
          `Meta criada: ${name}${owner ? ` (${owner.name})` : ''}.`,
          target !== undefined ? `Objetivo: ${formatBRL(target)}.` : 'Sem valor-alvo por enquanto.',
          deadline ? `Prazo: ${monthName(periodOf(deadline))}.` : null,
          planned !== undefined ? `Aporte planejado: ${formatBRL(planned)}/mês.` : null,
          `Para reservar dinheiro: /aporte ${name} VALOR @Conta`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
}

export interface GoalChanges {
  name?: string | undefined;
  target?: string | undefined;
  deadline?: string | undefined;
  planned?: string | undefined;
  notes?: string | undefined;
}

const CLEAR = new Set(['-', '?', 'nenhum', 'nenhuma']);

export async function editGoal(
  deps: Deps,
  actor: Actor,
  goalText: string,
  changes: GoalChanges,
): Promise<Effect> {
  const goals = await loadGoals(deps.db, actor.scope.household.id, actor.today);
  const found = findGoal(goals, goalText);
  if ('error' in found) return replyOnly(found.error);
  const goal = found.goal;
  const set: Partial<typeof financialGoals.$inferInsert> = {};
  const notes: string[] = [];

  if (changes.name !== undefined) {
    const name = changes.name.replaceAll('_', ' ').trim();
    const normalizedName = normalizeText(name);
    if (!normalizedName) return replyOnly('Nome inválido.');
    if (goals.some((g) => g.id !== goal.id && normalizeText(g.name) === normalizedName)) {
      return replyOnly('Já existe outra meta com esse nome.');
    }
    set.name = name;
    set.normalizedName = normalizedName;
    notes.push(`nome: ${name}`);
  }
  if (changes.target !== undefined) {
    if (CLEAR.has(changes.target)) {
      if (goal.kind === 'apartment') set.entryCents = null;
      else set.targetCents = null;
      notes.push('sem valor-alvo');
    } else {
      const parsed = parseBRL(changes.target);
      if (parsed.status !== 'ok') return replyOnly('Valor inválido. Exemplo: valor=8000');
      if (goal.kind === 'apartment') set.entryCents = parsed.cents;
      else set.targetCents = parsed.cents;
      notes.push(`objetivo: ${formatBRL(parsed.cents)}`);
    }
  }
  if (changes.planned !== undefined) {
    if (CLEAR.has(changes.planned)) {
      set.plannedMonthlyCents = null;
      notes.push('sem aporte planejado');
    } else {
      const parsed = parseBRL(changes.planned);
      if (parsed.status !== 'ok') return replyOnly('Valor inválido. Exemplo: aporte=500');
      set.plannedMonthlyCents = parsed.cents;
      notes.push(`aporte planejado: ${formatBRL(parsed.cents)}/mês`);
    }
  }
  if (changes.deadline !== undefined) {
    if (CLEAR.has(changes.deadline)) {
      set.deadline = null;
      notes.push('sem prazo');
    } else {
      const deadline = parseDeadline(changes.deadline, actor.today);
      if (deadline === null) return replyOnly('Prazo inválido. Use MM/AAAA.');
      set.deadline = deadline;
      notes.push(`prazo: ${monthName(periodOf(deadline))}`);
    }
  }
  if (changes.notes !== undefined) {
    set.notes = CLEAR.has(changes.notes) ? null : changes.notes.replaceAll('_', ' ');
    notes.push('observação atualizada');
  }
  if (notes.length === 0) {
    return replyOnly(
      `Nada para alterar. Exemplo: /meta editar ${goal.name} valor=9000 prazo=12/2027`,
    );
  }
  return {
    statements: [
      deps.db
        .update(financialGoals)
        .set({ ...set, updatedAt: deps.now() })
        .where(
          and(
            eq(financialGoals.id, goal.id),
            eq(financialGoals.householdId, actor.scope.household.id),
          ),
        ),
      auditStatement(deps, actor, 'goal.updated', 'goal', goal.id, { after: set }),
    ],
    replies: [{ text: `Meta ${goal.name} atualizada: ${notes.join(', ')}.` }],
  };
}

export async function requestGoalRemoval(
  deps: Deps,
  actor: Actor,
  goalText: string,
): Promise<Effect> {
  const goals = await loadGoals(deps.db, actor.scope.household.id, actor.today);
  const found = findGoal(goals, goalText);
  if ('error' in found) return replyOnly(found.error);
  const pendingId = deps.newId();
  const reserved = found.goal.progress.confirmedCents;
  return {
    statements: [
      createPendingStatement(deps, actor, pendingId, {
        type: 'archive_goal',
        goalId: found.goal.id,
      }),
    ],
    replies: [
      {
        text: `Arquivar a meta ${found.goal.name}?${reserved > 0 ? ` ${formatBRL(reserved)} reservados voltam a ficar livres nas contas; nenhum dinheiro é movido.` : ''} O histórico continua.`,
        buttons: confirmationButtons(pendingId),
      },
    ],
  };
}

export async function applyGoalArchive(
  deps: Deps,
  actor: Actor,
  goalId: string,
  extra: Stmt[],
): Promise<Effect> {
  const rows = await deps.db
    .select()
    .from(financialGoals)
    .where(
      and(
        eq(financialGoals.id, goalId),
        eq(financialGoals.householdId, actor.scope.household.id),
        eq(financialGoals.status, 'active'),
      ),
    )
    .limit(1);
  const goal = rows[0];
  if (!goal) return { statements: extra, replies: [{ text: 'Meta não encontrada.' }] };
  return {
    statements: [
      ...extra,
      deps.db
        .update(financialGoals)
        .set({ status: 'archived', updatedAt: deps.now() })
        .where(eq(financialGoals.id, goal.id)),
      auditStatement(deps, actor, 'goal.archived', 'goal', goal.id, {
        before: { status: 'active' },
        after: { status: 'archived' },
      }),
    ],
    replies: [{ text: `Meta ${goal.name} arquivada.` }],
  };
}

export interface GoalMovement {
  goalText: string | null;
  amountText: string;
  direction: 'in' | 'out';
  /** Onde o dinheiro esta (ou de onde sai a reserva). */
  accountText: string | null;
  /** Conta de origem: quando presente, ha transferencia real ate `accountText`. */
  sourceAccountText: string | null;
  dateText: string | null;
  /** allocation: dinheiro que ja existia. contribution: aporte novo do mes. */
  kind: 'contribution' | 'allocation';
  /** Mensagem natural: sem local claro, pergunta antes de registrar. */
  requireLocation: boolean;
  /** O usuario confirmou tirar dinheiro que estava reservado. */
  force?: boolean;
}

function findCashAccount(actor: Actor, text: string): { account: Account } | { error: string } {
  const accounts = actor.scope.accounts.filter((a) => a.kind !== 'credit_card');
  const match = matchAccount(text.replaceAll('_', ' '), accounts, { memberId: actor.member.id });
  if (match.status !== 'found' && normalizeText(text).includes('principal')) {
    const defaultId = parseMemberPreferences(actor.member.preferences).defaultAccountId;
    const account = accounts.find((a) => a.id === defaultId);
    if (account) return { account };
  }
  if (match.status === 'found') {
    return { account: accounts.find((a) => a.id === match.account.id)! };
  }
  if (match.status === 'ambiguous') {
    return { error: `Qual delas? ${match.options.map((a) => a.name).join(', ')}.` };
  }
  return {
    error: `Não achei a conta "${text}". Contas: ${accounts.map((a) => a.name).join(', ') || 'nenhuma'}.`,
  };
}

function progressLines(
  goal: GoalView,
  signed: number,
  countsForMonth: boolean,
  date: LocalDate,
  actor: Actor,
): string[] {
  const lines: string[] = [];
  const saved = goal.progress.confirmedCents + signed;
  const target = goal.progress.targetCents;
  lines.push(
    target
      ? `Agora são ${formatBRL(saved)} de ${formatBRL(target)} (${Math.min(Math.floor((Math.max(saved, 0) * 100) / target), 100)}%).`
      : `Agora são ${formatBRL(saved)} guardados. Defina o alvo com /meta editar ${goal.name} valor=VALOR.`,
  );
  const planned = goal.progress.plannedMonthlyCents;
  const month =
    goal.progress.confirmedThisMonthCents +
    (countsForMonth && periodOf(date) === periodOf(actor.today) ? signed : 0);
  if (planned && signed > 0 && countsForMonth) {
    lines.push(
      month >= planned
        ? `Meta do mês batida: ${formatBRL(month)} de ${formatBRL(planned)} pretendidos. 👏`
        : `No mês: ${formatBRL(month)} de ${formatBRL(planned)} pretendidos.`,
    );
  }
  return lines;
}

/**
 * Reserva ou libera dinheiro de uma meta. O saldo das contas so muda quando ha transferencia
 * explicita; reservar dinheiro que ja existe nao cria patrimonio. Tudo vai numa transacao.
 */
export async function moveGoalFunds(
  deps: Deps,
  actor: Actor,
  input: GoalMovement,
  idempotencyPrefix: string,
  extra: Stmt[] = [],
): Promise<Effect> {
  const parsed = parseBRL(input.amountText);
  if (parsed.status !== 'ok') return replyOnly('Não entendi o valor. Exemplo: 500,00.');
  const amount = parsed.cents;
  const date = resolveDateExpression(input.dateText ?? '', actor.today);
  if (date.status !== 'ok') return replyOnly('Data inválida. Exemplo: 03/11.');

  const [goals, positions] = await Promise.all([
    loadGoals(deps.db, actor.scope.household.id, actor.today),
    accountBalances(deps.db, actor.scope),
  ]);
  let account: Account | null = null;
  if (input.accountText) {
    const lookup = findCashAccount(actor, input.accountText);
    if ('error' in lookup) return replyOnly(lookup.error);
    account = lookup.account;
  }

  // Em linguagem natural, sem meta citada, so a do cofre informado ou a unica existente.
  let found: GoalLookup;
  if (input.requireLocation && !input.goalText && goals.length > 1) {
    const linked = goals.filter((g) => account && g.linkedAccountId === account.id);
    found =
      linked.length === 1
        ? { goal: linked[0]! }
        : { error: `Para qual meta? Opções: ${goals.map((g) => g.name).join(', ')}.` };
  } else {
    found = findGoal(goals, input.goalText);
  }
  if ('error' in found) return replyOnly(found.error);
  const goal = found.goal;

  const statements: Stmt[] = [...extra];
  const notes: string[] = [];
  let transactionId: string | null = null;

  if (input.direction === 'out') {
    const held = goal.locations.filter((l) => l.cents > 0);
    if (input.accountText) {
      const here = held.find((l) => l.accountId === account!.id);
      if (!here || here.cents < amount) {
        return replyOnly(
          `Em ${account!.name} só há ${formatBRL(here?.cents ?? 0)} reservados para ${goal.name}.`,
        );
      }
    } else {
      const enough = held.filter((l) => l.cents >= amount);
      if (held.length === 0 || goal.progress.confirmedCents < amount) {
        return replyOnly(
          `A meta ${goal.name} tem ${formatBRL(Math.max(goal.progress.confirmedCents, 0))} reservados.`,
        );
      }
      if (held.length > 1 || enough.length !== 1) {
        return replyOnly(
          `De onde sai? ${held.map((l) => `${l.accountName}: ${formatBRL(l.cents)}`).join(' · ')}. Repita com @Conta, ex.: /retirada ${goal.name} ${formatBRL(amount).replace('R$ ', '')} @Conta`,
        );
      }
      const only = enough[0]!;
      account = actor.scope.accounts.find((a) => a.id === only.accountId) ?? null;
    }
  } else {
    const source = input.sourceAccountText ? findCashAccount(actor, input.sourceAccountText) : null;
    if (source && 'error' in source) return replyOnly(source.error);
    if (source && !account) {
      const linked = goal.locations.filter((l) => l.accountId !== null);
      if (linked.length !== 1) return replyOnly('Para qual conta foi? Use @Destino.');
      account = actor.scope.accounts.find((a) => a.id === linked[0]!.accountId) ?? null;
    }

    if (!account && input.requireLocation) {
      const pendingId = deps.newId();
      const linkedName = actor.scope.accounts.find((a) => a.id === goal.linkedAccountId)?.name;
      return {
        statements: [
          ...extra,
          createPendingStatement(deps, actor, pendingId, {
            type: 'goal_location',
            movement: { ...input, goalText: goal.name, requireLocation: false },
            linkedAccountId: goal.linkedAccountId,
          }),
        ],
        replies: [
          {
            text: linkedName
              ? `Antes de reservar ${formatBRL(amount)} para ${goal.name}: a meta fica em ${linkedName}. O dinheiro já estava lá?\nResponda "sim", ou o nome da conta de onde ele veio, ou "não sei".`
              : `Antes de reservar ${formatBRL(amount)} para ${goal.name}: esse dinheiro já está em alguma conta, ou houve transferência?\nResponda o nome da conta onde ele está, ou "de Origem para Destino" se transferiu, ou "não sei".`,
          },
        ],
      };
    }

    if (source && 'account' in source) {
      if (source.account.id === account!.id) {
        return replyOnly('Origem e destino são a mesma conta.');
      }
      const from = positions.find((p) => p.id === source.account.id);
      if (!input.force && from && computeAvailability(from).freeCents !== null) {
        const free = computeAvailability(from).freeCents!;
        if (free < amount) {
          const pendingId = deps.newId();
          return {
            statements: [
              ...extra,
              createPendingStatement(deps, actor, pendingId, {
                type: 'goal_move',
                movement: { ...input, force: true },
              }),
            ],
            replies: [
              {
                text: `Em ${source.account.name} só há ${formatBRL(Math.max(free, 0))} livres (o resto está reservado para metas ou não consta no saldo). Registrar mesmo assim?`,
                buttons: confirmationButtons(pendingId),
              },
            ],
          };
        }
      }
      transactionId = deps.newId();
      const transfer: ResolvedTransaction = {
        type: 'transfer',
        transferKind: 'internal',
        amountCents: amount,
        description: `Reserva para ${goal.name}`,
        categoryId: null,
        categoryName: null,
        sourceAccountId: source.account.id,
        destinationAccountId: account!.id,
        sourceAccountName: source.account.name,
        destinationAccountName: account!.name,
        memberId: actor.member.id,
        memberName: actor.member.name,
        isShared: false,
        financialDate: date.date,
        isCreditPurchase: false,
        installments: null,
      };
      statements.push(
        ...statementsForTransaction(
          deps,
          actor,
          transfer,
          transactionId,
          `${idempotencyPrefix}:goal-transfer`,
          'command',
        ),
      );
      notes.push(`Transferi ${source.account.name} → ${account!.name}: não é despesa nem receita.`);
    }

    if (account) {
      const position = positions.find((p) => p.id === account!.id);
      if (position) {
        const { freeCents } = computeAvailability(position);
        const incoming = transactionId ? amount : 0;
        if (freeCents === null) {
          notes.push(`Saldo de ${account.name} desconhecido: não consegui validar essa reserva.`);
        } else if (freeCents + incoming < amount) {
          return replyOnly(
            `Em ${account.name} há ${formatBRL(Math.max(freeCents + incoming, 0))} livres; não dá para reservar ${formatBRL(amount)}. O mesmo dinheiro não pode valer duas vezes. Se ele veio de outra conta: /aporte ${goal.name} ${formatBRL(amount).replace('R$ ', '')} @${account.name} de:Origem`,
          );
        }
      }
    } else {
      notes.push('Local não informado: use @Conta para eu saber onde está esse dinheiro.');
    }
  }

  const contributionId = deps.newId();
  statements.push(
    deps.db.insert(goalContributions).values({
      id: contributionId,
      householdId: actor.scope.household.id,
      goalId: goal.id,
      amountCents: amount,
      direction: input.direction,
      kind: input.kind,
      accountId: account?.id ?? null,
      transactionId,
      contributionDate: date.date,
      memberId: actor.member.id,
      idempotencyKey: `${idempotencyPrefix}:goal`,
      createdAt: deps.now(),
    }),
    auditStatement(deps, actor, 'goal_contribution.created', 'goal_contribution', contributionId, {
      after: { amountCents: amount, direction: input.direction, accountId: account?.id ?? null },
    }),
  );

  const signed = input.direction === 'in' ? amount : -amount;
  const verb =
    input.direction === 'out'
      ? 'Retirada confirmada'
      : input.kind === 'allocation'
        ? 'Reserva confirmada'
        : 'Aporte confirmado';
  const where = account ? ` em ${account.name}` : '';
  const lines = [
    `${verb}: ${formatBRL(amount)} na meta ${goal.name}${where} (${formatDate(date.date)}).`,
    ...progressLines(goal, signed, input.kind === 'contribution', date.date, actor),
    ...notes,
  ];
  if (input.direction === 'out') {
    lines.push('O dinheiro segue na conta, agora livre. Se saiu de lá, registre o gasto.');
  }
  lines.push(`Desfazer: /estornar ${shortId(contributionId)}`);
  return { statements, replies: [{ text: lines.join('\n') }] };
}

/** Linhas do alerta quando um gasto consome dinheiro reservado. */
export function reservedShortfall(position: AccountBalance, amount: number): number | null {
  const { freeCents } = computeAvailability(position);
  if (freeCents === null || position.allocatedCents === 0) return null;
  return freeCents < amount
    ? Math.min(amount - Math.max(freeCents, 0), position.allocatedCents)
    : null;
}

/** Liga a meta a uma conta ou cofre. O que estava sem local passa para la, sem mover dinheiro. */
export async function linkGoalAccount(
  deps: Deps,
  actor: Actor,
  goalText: string | null,
  accountText: string,
): Promise<Effect> {
  const goals = await loadGoals(deps.db, actor.scope.household.id, actor.today);
  const found = findGoal(goals, goalText);
  if ('error' in found) return replyOnly(found.error);
  const goal = found.goal;
  const statements: Stmt[] = [];
  const notes: string[] = [];

  let accountId: string;
  let accountName: string;
  let knownFree: number | null = null;
  const lookup = findCashAccount(actor, accountText);
  if ('account' in lookup) {
    accountId = lookup.account.id;
    accountName = lookup.account.name;
    const position = (await accountBalances(deps.db, actor.scope)).find((p) => p.id === accountId);
    knownFree = position ? computeAvailability(position).freeCents : null;
  } else {
    accountId = deps.newId();
    accountName = accountText.replaceAll('_', ' ').trim();
    const owner = actor.scope.members.find((m) => m.id === goal.ownerMemberId);
    const created = await addAccount(deps, actor, {
      id: accountId,
      kind: 'reserve',
      name: accountName,
      openingText: null,
      isDefault: false,
      closingDay: null,
      dueDay: null,
      ownerText: owner?.name ?? 'casal',
    });
    if (created.statements.length === 0) return created;
    statements.push(...created.statements);
    notes.push(`Cadastrei ${accountName} como reserva, com saldo desconhecido.`);
  }

  const unlocated = goal.locations.find((l) => l.accountId === null)?.cents ?? 0;
  if (unlocated > 0) {
    if (knownFree !== null && knownFree < unlocated) {
      notes.push(
        `${formatBRL(unlocated)} seguem sem local: ${accountName} só tem ${formatBRL(Math.max(knownFree, 0))} livres.`,
      );
    } else {
      const base = {
        householdId: actor.scope.household.id,
        goalId: goal.id,
        amountCents: unlocated,
        kind: 'allocation' as const,
        contributionDate: actor.today,
        memberId: actor.member.id,
        createdAt: deps.now(),
      };
      statements.push(
        deps.db.insert(goalContributions).values({
          ...base,
          id: deps.newId(),
          direction: 'out',
          accountId: null,
          idempotencyKey: `${actor.eventId}:link-out`,
        }),
        deps.db.insert(goalContributions).values({
          ...base,
          id: deps.newId(),
          direction: 'in',
          accountId,
          idempotencyKey: `${actor.eventId}:link-in`,
        }),
      );
      notes.push(`${formatBRL(unlocated)} que estavam sem local agora constam em ${accountName}.`);
    }
  }

  statements.push(
    deps.db
      .update(financialGoals)
      .set({ linkedAccountId: accountId, updatedAt: deps.now() })
      .where(
        and(
          eq(financialGoals.id, goal.id),
          eq(financialGoals.householdId, actor.scope.household.id),
        ),
      ),
    auditStatement(deps, actor, 'goal.linked', 'goal', goal.id, { after: { accountId } }),
  );
  return {
    statements,
    replies: [{ text: [`Meta ${goal.name} agora fica em ${accountName}.`, ...notes].join('\n') }],
  };
}

/** Meta ligada a esta conta, quando so existe uma: transferir para o cofre e guardar para ela. */
export async function linkedGoalOf(
  deps: Deps,
  actor: Actor,
  accountId: string,
): Promise<GoalView | null> {
  const goals = await loadGoals(deps.db, actor.scope.household.id, actor.today);
  const linked = goals.filter((g) => g.linkedAccountId === accountId);
  return linked.length === 1 ? linked[0]! : null;
}
