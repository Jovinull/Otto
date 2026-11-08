import { and, eq } from 'drizzle-orm';
import type { ScheduleType } from '../../domain/finance/recurring';
import type { AccountKind } from '../../domain/finance/transactions';
import type { Tone } from '../../domain/household/settings';
import type { Stmt } from '../../infrastructure/database/client';
import {
  households,
  onboardingSessions,
  pendingActions,
} from '../../infrastructure/database/schema';
import { parseMonthExpression } from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import { addAccount, addCommitment, setBudget, updateApartmentGoal } from '../commands/planning';
import { confirmationButtons, createPendingStatement } from '../commands/record-transactions';
import { auditStatement } from '../commands/shared';
import type { Actor, Deps, Effect, Member } from '../context';
import { replyOnly } from '../context';
import { onboardingChecklist } from './help';

interface Schedule {
  scheduleType: ScheduleType;
  scheduleValue: number | null;
}

interface DraftAccount {
  kind: AccountKind;
  name: string;
  openingCents: number | null;
  closingDay: number | null;
  dueDay: number | null;
}

interface DraftBill extends Schedule {
  name: string;
  categorySlug: string | null;
  amountCents: number | null;
}

/** Rascunho do cadastro. Nada aqui afeta o dominio ate a confirmacao final. */
export interface OnboardingState {
  answered: string[];
  tone?: Tone;
  income: Record<string, { amountCents: number } & Partial<Schedule>>;
  accounts: DraftAccount[];
  bills: DraftBill[];
  budgets: Record<string, number>;
  goal: {
    entryCents?: number;
    costsCents?: number;
    deadline?: string;
    savedCents?: number;
    monthlyCents?: number;
    reserveCents?: number;
  };
}

const emptyState = (): OnboardingState => ({
  answered: [],
  income: {},
  accounts: [],
  bills: [],
  budgets: {},
  goal: {},
});

type Parsed<T> = { value: T } | { skip: true } | null;

const SKIP = new Set([
  'pular',
  'pula',
  'pulo',
  'depois',
  'nao sei',
  'sei la',
  'nao',
  'nao temos',
  'nao tenho',
  'nenhum',
  'nenhuma',
  'sem',
  '-',
]);
const DONE = new Set(['pronto', 'fim', 'acabou', 'so isso', 'e isso', 'terminei', 'nenhuma outra']);
/** Mensagens com estes verbos sao lancamentos, nao respostas do cadastro. */
const TRANSACTION_VERBS =
  /\b(gastei|gastamos|paguei|pagamos|comprei|compramos|recebi|transferi|guardei)\b/;

const clean = (text: string) =>
  normalizeText(text)
    .replace(/[.!]+$/, '')
    .trim();

function parseAmount(text: string): Parsed<number> {
  const value = clean(text);
  if (SKIP.has(value)) return { skip: true };
  const stripped = value
    .replace(/^(r\$|uns|umas|cerca de|mais ou menos|aproximadamente)\s*/g, '')
    .replace(/\s*(reais|por mes|ao mes|mensal|mensais|todo mes)$/g, '')
    .trim();
  const parsed = parseBRL(stripped);
  return parsed.status === 'ok' ? { value: parsed.cents } : null;
}

const ORDINALS: Record<string, number> = {
  primeiro: 1,
  segundo: 2,
  terceiro: 3,
  quarto: 4,
  quinto: 5,
  sexto: 6,
  setimo: 7,
  oitavo: 8,
  nono: 9,
  decimo: 10,
};

function parseSchedule(text: string): Parsed<Schedule> {
  const value = clean(text);
  if (SKIP.has(value) || /\bvaria\b/.test(value)) {
    return { value: { scheduleType: 'monthly_unspecified', scheduleValue: null } };
  }
  const business = /(\d{1,2}|[a-z]+)\s*[ºo°]?\s*dia\s+util/.exec(value);
  if (business) {
    const n = Number(business[1]) || ORDINALS[business[1]!];
    if (n && n >= 1 && n <= 23)
      return { value: { scheduleType: 'nth_weekday_approx', scheduleValue: n } };
  }
  const day = /^(?:todo\s+)?(?:dia\s+)?(\d{1,2})$/.exec(value);
  if (day && Number(day[1]) >= 1 && Number(day[1]) <= 31) {
    return { value: { scheduleType: 'monthly_day', scheduleValue: Number(day[1]) } };
  }
  return null;
}

const ACCOUNT_KINDS: Record<string, AccountKind> = {
  corrente: 'checking',
  conta: 'checking',
  poupanca: 'savings',
  dinheiro: 'cash',
  reserva: 'reserve',
  conjunta: 'joint',
  cartao: 'credit_card',
};

function parseAccount(text: string): Parsed<DraftAccount> | { done: true } {
  const value = clean(text);
  if (DONE.has(value) || SKIP.has(value)) return { done: true };
  const tokens = text.trim().split(/\s+/);
  const kind = ACCOUNT_KINDS[normalizeText(tokens[0] ?? '')];
  if (!kind || tokens.length < 2) return null;
  const rest = tokens.slice(1);
  const takeDay = (word: string) => {
    const index = rest.findIndex((t) => normalizeText(t) === word);
    if (index < 0) return null;
    const day = Number(rest[index + 1]);
    rest.splice(index, 2);
    return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
  };
  const closingDay = kind === 'credit_card' ? takeDay('fecha') : null;
  const dueDay = kind === 'credit_card' ? takeDay('vence') : null;
  let openingCents: number | null = null;
  const last = rest.at(-1);
  if (kind !== 'credit_card' && last && /\d/.test(last) && rest.length > 1) {
    const parsed = /^0+(,0{1,2})?$/.test(last) ? 0 : parseAmount(last);
    if (parsed === 0) openingCents = 0;
    else if (parsed && 'value' in parsed) openingCents = parsed.value;
    else return null;
    rest.pop();
  }
  const name = rest.join(' ').trim();
  if (!name) return null;
  return { value: { kind, name, openingCents, closingDay, dueDay } };
}

function parseBill(text: string): Parsed<Omit<DraftBill, 'name' | 'categorySlug'>> {
  const value = clean(text);
  if (SKIP.has(value)) return { skip: true };
  const match =
    /^(?:r\$\s*)?([\d.,]+(?:\s*mil)?|varia|variavel)(?:\s*reais)?(?:\s*(?:,|e)?\s*(?:vence\s*)?(?:todo\s+)?(?:dia\s+(\d{1,2})|(\d{1,2})\s*[ºo°]?\s*dia\s+util))?$/.exec(
      value,
    );
  if (!match) return null;
  let amountCents: number | null = null;
  if (!/^varia/.test(match[1]!)) {
    const parsed = parseBRL(match[1]!);
    if (parsed.status !== 'ok') return null;
    amountCents = parsed.cents;
  }
  const schedule: Schedule = match[2]
    ? { scheduleType: 'monthly_day', scheduleValue: Number(match[2]) }
    : match[3]
      ? { scheduleType: 'nth_weekday_approx', scheduleValue: Number(match[3]) }
      : { scheduleType: 'monthly_unspecified', scheduleValue: null };
  if (
    schedule.scheduleValue !== null &&
    (schedule.scheduleValue < 1 || schedule.scheduleValue > 31)
  ) {
    return null;
  }
  return { value: { amountCents, ...schedule } };
}

function parseOtherBill(text: string): Parsed<DraftBill> | { done: true } {
  const value = clean(text);
  if (DONE.has(value) || SKIP.has(value)) return { done: true };
  const match = /^(.+?)\s+((?:r\$\s*)?[\d.,]+|varia)\b(.*)$/.exec(text.trim());
  if (!match) return null;
  const bill = parseBill(`${match[2]}${match[3]}`);
  if (!bill || !('value' in bill)) return null;
  return { value: { name: match[1]!.trim(), categorySlug: null, ...bill.value } };
}

function parseDeadline(text: string, today: string): Parsed<string> {
  const value = clean(text);
  if (SKIP.has(value)) return { skip: true };
  const numeric = /^(\d{1,2})[/-](\d{4})$/.exec(value);
  if (numeric && Number(numeric[1]) >= 1 && Number(numeric[1]) <= 12) {
    return { value: `${numeric[1]!.padStart(2, '0')}/${numeric[2]}` };
  }
  const period = parseMonthExpression(value, today);
  if (period && /\d{4}/.test(value)) return { value: `${period.slice(5)}/${period.slice(0, 4)}` };
  return null;
}

const TONES: Record<string, Tone> = {
  neutro: 'neutral',
  amigavel: 'friendly',
  firme: 'firm',
};

const FIXED_BILLS = [
  { key: 'aluguel', label: 'Aluguel (ou prestação do imóvel)', category: 'moradia' },
  { key: 'condominio', label: 'Condomínio', category: 'moradia' },
  { key: 'energia', label: 'Energia', category: 'contas-domesticas' },
  { key: 'agua', label: 'Água', category: 'contas-domesticas' },
  { key: 'internet', label: 'Internet', category: 'contas-domesticas' },
];

const BUDGET_CATEGORIES = [
  { slug: 'supermercado', label: 'supermercado' },
  { slug: 'delivery', label: 'delivery' },
  { slug: 'transporte', label: 'transporte (Uber, combustível, ônibus)' },
  { slug: 'lazer', label: 'lazer' },
  { slug: 'compras-pessoais', label: 'compras pessoais' },
];

interface Step {
  id: string;
  group: StepGroup;
  ask: (state: OnboardingState) => string;
  /** Aplica a resposta ao rascunho; null quando a mensagem nao e uma resposta. */
  apply: (state: OnboardingState, text: string, today: string) => 'ok' | 'loop' | null;
  when?: (state: OnboardingState) => boolean;
}

export type StepGroup = 'pessoas' | 'renda' | 'contas' | 'fixas' | 'orcamento' | 'apartamento';
const GROUPS: StepGroup[] = ['pessoas', 'renda', 'contas', 'fixas', 'orcamento', 'apartamento'];

function amountStep(
  id: string,
  group: StepGroup,
  ask: (state: OnboardingState) => string,
  store: (state: OnboardingState, cents: number) => void,
): Step {
  return {
    id,
    group,
    ask,
    apply: (state, text) => {
      const parsed = parseAmount(text);
      if (!parsed) return null;
      if ('value' in parsed) store(state, parsed.value);
      return 'ok';
    },
  };
}

function totalIncome(state: OnboardingState): number {
  return Object.values(state.income).reduce((sum, i) => sum + i.amountCents, 0);
}

function totalBills(state: OnboardingState): number {
  return state.bills.reduce((sum, b) => sum + (b.amountCents ?? 0), 0);
}

function buildSteps(members: readonly Member[]): Step[] {
  const names = members.map((m) => m.name).join(' e ');
  const steps: Step[] = [
    {
      id: 'tom',
      group: 'pessoas',
      ask: () =>
        `Vamos configurar o Otto em etapas curtas. Responda aqui mesmo; "pular" pula uma pergunta e /configurar pausar deixa para depois. Lançamentos continuam funcionando no meio do caminho.\n\nEtapa 1/6 — Pessoas: vocês são ${names}. Como preferem que eu fale: neutro, amigável ou firme?`,
      apply: (state, text) => {
        const value = clean(text);
        if (SKIP.has(value)) return 'ok';
        const tone = TONES[value];
        if (!tone) return null;
        state.tone = tone;
        return 'ok';
      },
    },
  ];
  members.forEach((member, index) => {
    steps.push(
      amountStep(
        `renda:${member.id}`,
        'renda',
        () =>
          `${index === 0 ? 'Etapa 2/6 — Renda. É só previsão: nada conta como recebido até vocês avisarem.\n' : ''}Quanto ${member.name} costuma receber por mês? (valor ou "pular")`,
        (state, cents) => {
          state.income[member.id] = { amountCents: cents };
        },
      ),
      {
        id: `renda_dia:${member.id}`,
        group: 'renda',
        when: (state) => state.income[member.id] !== undefined,
        ask: () =>
          `Em que dia costuma cair a renda de ${member.name}? Ex.: "dia 5", "5º dia útil" ou "varia".`,
        apply: (state, text) => {
          const parsed = parseSchedule(text);
          if (!parsed || !('value' in parsed)) return null;
          Object.assign(state.income[member.id]!, parsed.value);
          return 'ok';
        },
      },
    );
  });
  steps.push({
    id: 'contas',
    group: 'contas',
    ask: (state) =>
      state.accounts.length === 0
        ? 'Etapa 3/6 — Contas. Mande uma por mensagem, assim:\n• corrente Nubank 1200 (saldo de hoje, opcional)\n• reserva Caixinha 5000\n• cartao Nubank fecha 3 vence 10\nSó informe saldo que vocês conferiram. Quando terminar, "pronto".'
        : `Anotei: ${state.accounts.map((a) => a.name).join(', ')}. Mais alguma? Ou "pronto".`,
    apply: (state, text) => {
      const parsed = parseAccount(text);
      if (!parsed) return null;
      if ('done' in parsed) return 'ok';
      if (!('value' in parsed)) return 'ok';
      const exists = state.accounts.some(
        (a) => normalizeText(a.name) === normalizeText(parsed.value.name),
      );
      if (!exists) state.accounts.push(parsed.value);
      return 'loop';
    },
  });
  FIXED_BILLS.forEach((bill, index) => {
    steps.push({
      id: `fixa:${bill.key}`,
      group: 'fixas',
      ask: () =>
        `${index === 0 ? 'Etapa 4/6 — Contas fixas. Também são previsão: só ficam pagas quando vocês avisarem.\n' : ''}${bill.label}: quanto e em que dia vence? Ex.: "1200 dia 5", "varia dia 10" ou "não temos".`,
      apply: (state, text) => {
        const parsed = parseBill(text);
        if (!parsed) return null;
        if ('value' in parsed) {
          state.bills = state.bills.filter((b) => b.name !== bill.label);
          state.bills.push({ name: bill.label, categorySlug: bill.category, ...parsed.value });
        }
        return 'ok';
      },
    });
  });
  steps.push({
    id: 'fixas_outras',
    group: 'fixas',
    ask: () =>
      'Outros compromissos fixos (assinaturas, parcelas, escola, plano de saúde)? Um por mensagem, ex.: "netflix 55,90 dia 12". Quando terminar, "pronto".',
    apply: (state, text) => {
      const parsed = parseOtherBill(text);
      if (!parsed) return null;
      if ('done' in parsed) return 'ok';
      if ('value' in parsed) state.bills.push(parsed.value);
      return 'loop';
    },
  });
  BUDGET_CATEGORIES.forEach((category, index) => {
    steps.push(
      amountStep(
        `orc:${category.slug}`,
        'orcamento',
        (state) => {
          if (index > 0) return `Limite mensal para ${category.label}? (valor ou "pular")`;
          const income = totalIncome(state);
          const bills = totalBills(state);
          const context =
            income > 0
              ? `Pelo que vocês disseram: renda prevista ${formatBRL(income)}, contas fixas ${formatBRL(bills)}, sobram ${formatBRL(income - bills)} para o resto do mês (antes de guardar). Não vou impor percentuais: vocês decidem.`
              : 'Sem renda informada, não tenho como sugerir uma divisão: vocês decidem os valores.';
          return `Etapa 5/6 — Orçamento. ${context}\nLimite mensal para ${category.label}? (valor ou "pular")`;
        },
        (state, cents) => {
          state.budgets[category.slug] = cents;
        },
      ),
    );
  });
  steps.push(
    amountStep(
      'meta:entrada',
      'apartamento',
      () => 'Etapa 6/6 — Apartamento. Quanto vocês querem dar de entrada? (valor ou "pular")',
      (state, cents) => {
        state.goal.entryCents = cents;
      },
    ),
    amountStep(
      'meta:custos',
      'apartamento',
      () => 'Custos da compra (ITBI, cartório, mudança)? Valor ou "não sei".',
      (state, cents) => {
        state.goal.costsCents = cents;
      },
    ),
    {
      id: 'meta:prazo',
      group: 'apartamento',
      ask: () => 'Até quando querem ter esse valor? Ex.: 12/2027.',
      apply: (state, text, today) => {
        const parsed = parseDeadline(text, today);
        if (!parsed) return null;
        if ('value' in parsed) state.goal.deadline = parsed.value;
        return 'ok';
      },
    },
    amountStep(
      'meta:guardado',
      'apartamento',
      () =>
        'Quanto já está guardado e reservado para o apartamento? Só dinheiro que já existe; "0" se ainda nada.',
      (state, cents) => {
        state.goal.savedCents = cents;
      },
    ),
    amountStep(
      'meta:aporte',
      'apartamento',
      () => 'Quanto pretendem guardar por mês? (é intenção; só conta quando vocês guardarem)',
      (state, cents) => {
        state.goal.monthlyCents = cents;
      },
    ),
    amountStep(
      'meta:reserva',
      'apartamento',
      () => 'Têm reserva de emergência separada da meta? Valor ou "não".',
      (state, cents) => {
        state.goal.reserveCents = cents;
      },
    ),
  );
  return steps;
}

async function loadSession(deps: Deps, householdId: string) {
  const rows = await deps.db
    .select()
    .from(onboardingSessions)
    .where(eq(onboardingSessions.householdId, householdId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, state: { ...emptyState(), ...(JSON.parse(row.state) as OnboardingState) } };
}

function saveStatement(
  deps: Deps,
  actor: Actor,
  status: 'active' | 'paused' | 'completed',
  state: OnboardingState,
): Stmt {
  const values = {
    householdId: actor.scope.household.id,
    status,
    conductorMemberId: actor.member.id,
    state: JSON.stringify(state),
    updatedAt: deps.now(),
  };
  return deps.db
    .insert(onboardingSessions)
    .values(values)
    .onConflictDoUpdate({ target: onboardingSessions.householdId, set: values });
}

/** Encerra perguntas abertas do cadastro, para so a mais recente valer. */
function closeOpenQuestions(deps: Deps, actor: Actor): Stmt {
  return deps.db
    .update(pendingActions)
    .set({ status: 'cancelled', resolvedAt: deps.now() })
    .where(
      and(
        eq(pendingActions.householdId, actor.scope.household.id),
        eq(pendingActions.status, 'pending'),
        eq(pendingActions.kind, 'onboarding'),
      ),
    );
}

function nextStep(steps: readonly Step[], state: OnboardingState): Step | null {
  return (
    steps.find((s) => !state.answered.includes(s.id) && (s.when ? s.when(state) : true)) ?? null
  );
}

function summary(state: OnboardingState, members: readonly Member[]): string {
  const lines = ['Resumo do que vou ativar:'];
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? 'Membro';
  if (state.tone)
    lines.push(`• Tom: ${{ neutral: 'neutro', friendly: 'amigável', firm: 'firme' }[state.tone]}`);
  for (const [memberId, income] of Object.entries(state.income)) {
    lines.push(`• Renda prevista de ${name(memberId)}: ${formatBRL(income.amountCents)}/mês`);
  }
  for (const account of state.accounts) {
    const detail =
      account.kind === 'credit_card'
        ? account.closingDay && account.dueDay
          ? ` (fecha ${account.closingDay}, vence ${account.dueDay})`
          : ' (sem dias de fatura)'
        : account.openingCents === null
          ? ' (saldo não informado)'
          : ` (saldo ${formatBRL(account.openingCents)})`;
    lines.push(`• Conta: ${account.name}${detail}`);
  }
  for (const bill of state.bills) {
    lines.push(
      `• Conta fixa: ${bill.name} ${bill.amountCents === null ? 'valor variável' : formatBRL(bill.amountCents)}`,
    );
  }
  for (const [slug, cents] of Object.entries(state.budgets)) {
    lines.push(`• Limite de ${slug}: ${formatBRL(cents)}/mês`);
  }
  const goal = state.goal;
  if (Object.keys(goal).length > 0) {
    const parts = [
      goal.entryCents !== undefined ? `entrada ${formatBRL(goal.entryCents)}` : null,
      goal.costsCents !== undefined ? `custos ${formatBRL(goal.costsCents)}` : null,
      goal.deadline ? `prazo ${goal.deadline}` : null,
      goal.savedCents !== undefined ? `já guardado ${formatBRL(goal.savedCents)}` : null,
      goal.monthlyCents !== undefined
        ? `pretendem guardar ${formatBRL(goal.monthlyCents)}/mês`
        : null,
    ].filter(Boolean);
    lines.push(`• Apartamento: ${parts.join(', ')}`);
    if (goal.reserveCents !== undefined) {
      lines.push(`• Reserva de emergência (fora da meta): ${formatBRL(goal.reserveCents)}`);
    }
  }
  if (lines.length === 1) lines.push('• Nada informado ainda.');
  const income = totalIncome(state);
  if (income > 0) {
    lines.push(
      `Renda prevista ${formatBRL(income)} − contas fixas ${formatBRL(totalBills(state))} = ${formatBRL(income - totalBills(state))} por mês antes de lazer, compras e da meta.`,
    );
  }
  lines.push(
    'Para corrigir uma etapa: /configurar renda, contas, fixas, orcamento ou apartamento.',
  );
  return lines.join('\n');
}

async function ask(deps: Deps, actor: Actor, state: OnboardingState, prefix = ''): Promise<Effect> {
  const steps = buildSteps(actor.scope.members.filter((m) => m.status === 'active'));
  const step = nextStep(steps, state);
  const statements: Stmt[] = [
    closeOpenQuestions(deps, actor),
    saveStatement(deps, actor, 'active', state),
  ];
  const pendingId = deps.newId();
  if (!step) {
    statements.push(createPendingStatement(deps, actor, pendingId, { type: 'onboarding_confirm' }));
    return {
      statements,
      replies: [
        {
          text: `${prefix}${summary(state, actor.scope.members)}\nConfirma?`,
          buttons: confirmationButtons(pendingId),
        },
      ],
    };
  }
  statements.push(
    createPendingStatement(deps, actor, pendingId, { type: 'onboarding', step: step.id }),
  );
  return { statements, replies: [{ text: `${prefix}${step.ask(state)}` }] };
}

/** /configurar e variacoes. */
export async function onboardingCommand(
  deps: Deps,
  actor: Actor,
  args: readonly string[],
): Promise<Effect> {
  const option = normalizeText(args[0] ?? '');
  const session = await loadSession(deps, actor.scope.household.id);
  if (option === 'status') return replyOnly(await onboardingChecklist(deps, actor));
  if (option === 'pausar') {
    if (!session || session.status !== 'active') return replyOnly('Nenhum cadastro em andamento.');
    return {
      statements: [
        closeOpenQuestions(deps, actor),
        saveStatement(deps, actor, 'paused', session.state),
      ],
      replies: [
        { text: 'Cadastro pausado. Nada foi perdido: /configurar continua de onde parou.' },
      ],
    };
  }
  if (!session || option === 'refazer') return ask(deps, actor, emptyState());
  if (session.status === 'completed' && option === '') {
    return replyOnly(
      `${await onboardingChecklist(deps, actor)}\n\nO cadastro guiado já foi concluído. Para refazer: /configurar refazer. Para ajustar uma parte: /configurar renda, contas, fixas, orcamento ou apartamento.`,
    );
  }
  const state = session.state;
  if ((GROUPS as string[]).includes(option)) {
    const steps = buildSteps(actor.scope.members);
    const ids = new Set(steps.filter((s) => s.group === option).map((s) => s.id));
    state.answered = state.answered.filter((id) => !ids.has(id));
    if (option === 'contas') state.accounts = [];
    if (option === 'fixas') state.bills = [];
    if (option === 'orcamento') state.budgets = {};
    if (option === 'apartamento') state.goal = {};
    if (option === 'renda') state.income = {};
    return ask(deps, actor, state, 'Vamos refazer essa parte.\n');
  }
  return ask(
    deps,
    actor,
    state,
    session.status === 'paused' ? 'Continuando de onde paramos.\n' : '',
  );
}

/** Resposta a uma pergunta do cadastro. Null quando a mensagem nao e uma resposta valida. */
export async function onboardingAnswer(
  deps: Deps,
  actor: Actor,
  stepId: string,
  text: string,
): Promise<Effect | null> {
  if (TRANSACTION_VERBS.test(normalizeText(text))) return null;
  const session = await loadSession(deps, actor.scope.household.id);
  if (!session || session.status !== 'active') return null;
  const steps = buildSteps(actor.scope.members.filter((m) => m.status === 'active'));
  const step = steps.find((s) => s.id === stepId);
  if (!step) return null;
  const state = session.state;
  const result = step.apply(state, text, actor.today);
  if (result === null) return null;
  if (result === 'ok') state.answered.push(step.id);
  return ask(deps, actor, state);
}

/** Ativa tudo do rascunho numa unica transacao. */
export async function applyOnboarding(deps: Deps, actor: Actor, extra: Stmt[]): Promise<Effect> {
  const session = await loadSession(deps, actor.scope.household.id);
  if (!session || session.status === 'completed') {
    return { statements: extra, replies: [{ text: 'Não há cadastro pendente de confirmação.' }] };
  }
  const state = session.state;
  const statements: Stmt[] = [...extra];
  const problems: string[] = [];
  const money = (cents: number | undefined) =>
    cents === undefined ? null : formatBRL(cents).replace('R$ ', '');
  const collect = (effect: Effect, label: string) => {
    if (effect.statements.length === 0)
      problems.push(`${label}: ${effect.replies[0]?.text ?? 'não aplicado'}`);
    statements.push(...effect.statements);
  };

  if (state.tone) {
    statements.push(
      deps.db
        .update(households)
        .set({ settings: JSON.stringify({ ...actor.scope.settings, tone: state.tone }) })
        .where(eq(households.id, actor.scope.household.id)),
    );
  }
  const existing = new Set(actor.scope.accounts.map((a) => a.normalizedName));
  // Sem conta padrao, cada gasto perguntaria de qual conta saiu.
  let needsDefault = !actor.scope.accounts.some((a) => a.isDefault);
  for (const account of state.accounts) {
    if (existing.has(normalizeText(account.name))) continue;
    const isDefault = needsDefault && ['checking', 'joint', 'cash'].includes(account.kind);
    if (isDefault) needsDefault = false;
    collect(
      await addAccount(deps, actor, {
        kind: account.kind,
        name: account.name,
        openingText: money(account.openingCents ?? undefined),
        isDefault,
        closingDay: account.closingDay,
        dueDay: account.dueDay,
        ownerText: null,
      }),
      account.name,
    );
  }
  for (const [memberId, income] of Object.entries(state.income)) {
    const member = actor.scope.members.find((m) => m.id === memberId);
    if (!member) continue;
    collect(
      await addCommitment(deps, actor, {
        kind: 'income',
        description: 'Salário',
        amountText: formatBRL(income.amountCents).replace('R$ ', ''),
        scheduleType: income.scheduleType ?? 'monthly_unspecified',
        scheduleValue: income.scheduleValue ?? null,
        personText: member.name,
        categoryText: 'salario',
      }),
      `renda de ${member.name}`,
    );
  }
  for (const bill of state.bills) {
    collect(
      await addCommitment(deps, actor, {
        kind: 'expense',
        description: bill.name,
        amountText:
          bill.amountCents === null ? null : formatBRL(bill.amountCents).replace('R$ ', ''),
        scheduleType: bill.scheduleType,
        scheduleValue: bill.scheduleValue,
        personText: null,
        categoryText: bill.categorySlug,
      }),
      bill.name,
    );
  }
  for (const [slug, cents] of Object.entries(state.budgets)) {
    collect(
      await setBudget(deps, actor, slug, formatBRL(cents).replace('R$ ', ''), null),
      `limite de ${slug}`,
    );
  }
  const goal = state.goal;
  if (Object.keys(goal).length > 0) {
    collect(
      await updateApartmentGoal(deps, actor, {
        entry: money(goal.entryCents),
        additionalCosts: money(goal.costsCents),
        deadline: goal.deadline ?? null,
        plannedMonthly: money(goal.monthlyCents),
        emergencyReserve: money(goal.reserveCents),
        initialConfirmed: goal.savedCents ? money(goal.savedCents) : null,
      }),
      'meta',
    );
  }
  statements.push(
    saveStatement(deps, actor, 'completed', state),
    auditStatement(deps, actor, 'onboarding.completed', 'household', actor.scope.household.id, {}),
  );
  const text = [
    'Configuração ativada ✅',
    ...(problems.length ? ['Não consegui aplicar:', ...problems.map((p) => `• ${p}`)] : []),
    'Veja o que ainda falta com /configurar status. A partir daqui é só lançar os gastos normalmente.',
  ].join('\n');
  return { statements, replies: [{ text }] };
}
