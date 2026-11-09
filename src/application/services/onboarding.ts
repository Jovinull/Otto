import { and, eq } from 'drizzle-orm';
import type { ScheduleType } from '../../domain/finance/recurring';
import type { AccountKind } from '../../domain/finance/transactions';
import { accountIdentityKey } from '../../domain/finance/transactions';
import type { HouseholdSettings, Tone } from '../../domain/household/settings';
import { parseMemberPreferences } from '../../domain/household/settings';
import type { Stmt } from '../../infrastructure/database/client';
import {
  households,
  onboardingSessions,
  pendingActions,
  recurringEntries,
} from '../../infrastructure/database/schema';
import { parseMonthExpression } from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import { createGoal } from '../commands/goals';
import {
  addAccount,
  addCommitment,
  setBudget,
  setMemberDefaultStatement,
  updateApartmentGoal,
} from '../commands/planning';
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
  /** Nome da pessoa ou "casal". Vazio: de quem conduz o cadastro. */
  ownerText?: string | null;
}

interface DraftGoal {
  name: string;
  targetCents: number;
  deadline: string | null;
}

interface DraftIncome extends Schedule {
  name: string;
  amountCents: number;
  ownerText: string | null;
  irregular: boolean;
}

type AlertChoice = 'todos' | 'contas' | 'resumos' | 'nenhum';

interface DraftBill extends Schedule {
  name: string;
  categorySlug: string | null;
  amountCents: number | null;
}

/** Rascunho do cadastro. Nada aqui afeta o dominio ate a confirmacao final. */
export interface OnboardingState {
  answered: string[];
  tone?: Tone;
  income: Record<string, { amountCents: number; accountName?: string } & Partial<Schedule>>;
  defaults: Record<string, { accountName?: string; cardName?: string }>;
  extraGoals: DraftGoal[];
  extraIncome: DraftIncome[];
  alerts?: AlertChoice;
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
    accountName?: string;
  };
}

const emptyState = (): OnboardingState => ({
  answered: [],
  income: {},
  defaults: {},
  extraGoals: [],
  extraIncome: [],
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

function parseAccount(
  text: string,
  members: readonly Member[],
): Parsed<DraftAccount> | { done: true } {
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
  let ownerText: string | null = null;
  const ownerIndex = rest.findIndex((token, index) => {
    if (!['de', 'dono'].includes(normalizeText(token))) return false;
    const next = normalizeText(rest[index + 1] ?? '');
    return members.some((m) => normalizeText(m.name).split(' ')[0] === next);
  });
  if (ownerIndex >= 0) {
    ownerText = rest[ownerIndex + 1]!;
    rest.splice(ownerIndex, 2);
  } else {
    const shared = rest.findIndex((t) =>
      ['casal', 'compartilhada', 'compartilhado'].includes(normalizeText(t)),
    );
    if (shared >= 0) {
      ownerText = 'casal';
      rest.splice(shared, 1);
    }
  }
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
  return { value: { kind, name, openingCents, closingDay, dueDay, ownerText } };
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

function parseExtraGoal(text: string, today: string): Parsed<DraftGoal> | { done: true } {
  const value = clean(text);
  if (DONE.has(value) || SKIP.has(value)) return { done: true };
  const match = /^(.+?)\s+((?:r\$\s*)?[\d.,]+(?:\s*mil)?)(?:\s+at[eé]\s+(\S+))?$/i.exec(
    text.trim(),
  );
  if (!match) return null;
  const parsed = parseBRL(match[2]!.replace(/^r\$\s*/i, ''));
  if (parsed.status !== 'ok') return null;
  let deadline: string | null = null;
  if (match[3]) {
    const when = parseDeadline(match[3], today);
    if (!when || !('value' in when)) return null;
    deadline = when.value;
  }
  return { value: { name: match[1]!.trim(), targetCents: parsed.cents, deadline } };
}

function parseExtraIncome(
  text: string,
  members: readonly Member[],
): Parsed<DraftIncome> | { done: true } {
  const value = clean(text);
  if (DONE.has(value) || SKIP.has(value)) return { done: true };
  const tokens = text.trim().split(/\s+/);
  let ownerText: string | null = null;
  const ownerIndex = tokens.findIndex((token, index) => {
    if (normalizeText(token) !== 'de') return false;
    const next = normalizeText(tokens[index + 1] ?? '');
    return members.some((m) => normalizeText(m.name).split(' ')[0] === next);
  });
  if (ownerIndex >= 0) {
    ownerText = tokens[ownerIndex + 1]!;
    tokens.splice(ownerIndex, 2);
  }
  const irregularIndex = tokens.findIndex((t) => normalizeText(t) === 'irregular');
  const irregular = irregularIndex >= 0;
  if (irregular) tokens.splice(irregularIndex, 1);
  const parsed = parseOtherBill(tokens.join(' '));
  if (!parsed || !('value' in parsed) || parsed.value.amountCents === null) return null;
  const { name, amountCents, scheduleType, scheduleValue } = parsed.value;
  return { value: { name, amountCents, scheduleType, scheduleValue, ownerText, irregular } };
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

export type StepGroup =
  'pessoas' | 'renda' | 'contas' | 'fixas' | 'orcamento' | 'apartamento' | 'alertas';
const GROUPS: StepGroup[] = [
  'pessoas',
  'renda',
  'contas',
  'fixas',
  'orcamento',
  'apartamento',
  'alertas',
];

/** Dono de uma conta do rascunho. Nulo: conta do casal. */
function draftOwner(actor: Actor, account: DraftAccount): string | null {
  if (!account.ownerText) return account.kind === 'joint' ? null : actor.member.id;
  const text = normalizeText(account.ownerText);
  if (text === 'casal') return null;
  return (
    actor.scope.members.find((m) => normalizeText(m.name).split(' ')[0] === text.split(' ')[0])
      ?.id ?? actor.member.id
  );
}

/** Contas ou cartoes da pessoa, somando o que ja existe e o que esta no rascunho. */
function eligibleNames(
  actor: Actor,
  state: OnboardingState,
  memberId: string,
  card: boolean,
): string[] {
  const accepts = (kind: string) =>
    card
      ? kind === 'credit_card'
      : kind !== 'credit_card' && kind !== 'reserve' && kind !== 'joint';
  const names = [
    ...actor.scope.accounts
      .filter((a) => a.ownerMemberId === memberId && accepts(a.kind))
      .map((a) => a.name),
    ...state.accounts
      .filter((a) => draftOwner(actor, a) === memberId && accepts(a.kind))
      .map((a) => a.name),
  ];
  return [...new Set(names)];
}

function findName(options: readonly string[], text: string): string | null {
  const wanted = normalizeText(text);
  return options.find((name) => normalizeText(name) === wanted) ?? null;
}

interface LocationOption {
  label: string;
  name: string;
  ownerId: string | null;
}

const accountKey = (ownerId: string | null, card: boolean, name: string): string =>
  `${ownerId ?? 'casal'}|${card ? 'card' : 'cash'}|${normalizeText(name)}`;

/** Contas onde o dinheiro da meta pode estar; nomes repetidos levam o dono no rotulo. */
function locationOptions(actor: Actor, state: OnboardingState): LocationOption[] {
  const all = [
    ...actor.scope.accounts
      .filter((a) => a.kind !== 'credit_card')
      .map((a) => ({ name: a.name, ownerId: a.ownerMemberId })),
    ...state.accounts
      .filter((a) => a.kind !== 'credit_card')
      .map((a) => ({ name: a.name, ownerId: draftOwner(actor, a) })),
  ];
  const unique = all.filter(
    (a, index) =>
      all.findIndex(
        (b) => accountKey(b.ownerId, false, b.name) === accountKey(a.ownerId, false, a.name),
      ) === index,
  );
  return unique.map((a) => {
    const repeated = unique.filter((b) => normalizeText(b.name) === normalizeText(a.name)).length;
    const owner = actor.scope.members.find((m) => m.id === a.ownerId)?.name ?? 'casal';
    return { ...a, label: repeated > 1 ? `${a.name} ${owner}` : a.name };
  });
}

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
  const main = Object.values(state.income).reduce((sum, i) => sum + i.amountCents, 0);
  return (
    main + state.extraIncome.filter((i) => !i.irregular).reduce((sum, i) => sum + i.amountCents, 0)
  );
}

function totalBills(state: OnboardingState): number {
  return state.bills.reduce((sum, b) => sum + (b.amountCents ?? 0), 0);
}

function buildSteps(actor: Actor): Step[] {
  const members = actor.scope.members.filter((m) => m.status === 'active');
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
    id: 'renda_extra',
    group: 'renda',
    when: (state) => Object.keys(state.income).length > 0,
    ask: () =>
      `Mais alguma renda além do salário? Uma por mensagem: "Freelance 600 dia 10", "Bico 300 irregular" ou "Aluguel 900 dia 5 de ${members[1]?.name ?? 'Nome'}". Quando terminar, "pronto".`,
    apply: (state, text) => {
      const parsed = parseExtraIncome(text, members);
      if (!parsed) return null;
      if ('done' in parsed || !('value' in parsed)) return 'ok';
      state.extraIncome.push(parsed.value);
      return 'loop';
    },
  });
  steps.push({
    id: 'contas',
    group: 'contas',
    ask: (state) =>
      state.accounts.length === 0
        ? `Etapa 3/6 — Contas e cartões de cada um. Mande uma por mensagem, assim:\n• corrente Nubank 1200 (saldo de hoje, opcional)\n• corrente Nubank 800 de ${members[1]?.name ?? 'Nome'}\n• conjunta Casa 1500 casal\n• reserva Caixinha 5000\n• cartao Nubank fecha 3 vence 10\nSó informe saldo que vocês conferiram. Quando terminar, "pronto".`
        : `Anotei: ${state.accounts.map((a) => a.name).join(', ')}. Mais alguma? Ou "pronto".`,
    apply: (state, text) => {
      const parsed = parseAccount(text, members);
      if (!parsed) return null;
      if ('done' in parsed) return 'ok';
      if (!('value' in parsed)) return 'ok';
      const exists = state.accounts.some(
        (a) =>
          normalizeText(a.name) === normalizeText(parsed.value.name) &&
          (a.kind === 'credit_card') === (parsed.value.kind === 'credit_card') &&
          draftOwner(actor, a) === draftOwner(actor, parsed.value),
      );
      if (!exists) state.accounts.push(parsed.value);
      return 'loop';
    },
  });
  members.forEach((member) => {
    const preferences = parseMemberPreferences(member.preferences);
    const defaultStep = (card: boolean, current: string | undefined): Step => ({
      id: `padrao:${card ? 'cartao' : 'conta'}:${member.id}`,
      group: 'contas',
      when: (state) => !current && eligibleNames(actor, state, member.id, card).length > 1,
      ask: (state) =>
        `Qual é ${card ? 'o cartão padrão' : 'a conta principal'} de ${member.name}? Opções: ${eligibleNames(actor, state, member.id, card).join(', ')}.`,
      apply: (state, text) => {
        if (SKIP.has(clean(text))) return 'ok';
        const name = findName(eligibleNames(actor, state, member.id, card), text);
        if (!name) return null;
        state.defaults[member.id] = {
          ...state.defaults[member.id],
          [card ? 'cardName' : 'accountName']: name,
        };
        return 'ok';
      },
    });
    steps.push(defaultStep(false, preferences.defaultAccountId));
    steps.push(defaultStep(true, preferences.defaultCardId));
    steps.push({
      id: `renda_conta:${member.id}`,
      group: 'contas',
      when: (state) =>
        state.income[member.id] !== undefined &&
        eligibleNames(actor, state, member.id, false).length > 1,
      ask: (state) =>
        `Em qual conta costuma cair a renda de ${member.name}? Opções: ${eligibleNames(actor, state, member.id, false).join(', ')}.`,
      apply: (state, text) => {
        if (SKIP.has(clean(text))) return 'ok';
        const name = findName(eligibleNames(actor, state, member.id, false), text);
        if (!name) return null;
        state.income[member.id]!.accountName = name;
        return 'ok';
      },
    });
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
    {
      id: 'meta:local',
      group: 'apartamento',
      when: (state) => (state.goal.savedCents ?? 0) > 0,
      ask: (state) =>
        `Em qual conta ou cofre está esse dinheiro? Opções: ${
          locationOptions(actor, state)
            .map((o) => o.label)
            .join(', ') || 'nenhuma cadastrada'
        }. Ou "não sei".`,
      apply: (state, text) => {
        if (SKIP.has(clean(text))) return 'ok';
        const name = findName(
          locationOptions(actor, state).map((o) => o.label),
          text,
        );
        if (!name) return null;
        state.goal.accountName = name;
        return 'ok';
      },
    },
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
    {
      id: 'metas_outras',
      group: 'apartamento',
      ask: () =>
        'Outras metas? Uma por mensagem, ex.: "Viagem 8000" ou "Computador 6000 até 12/2027". Quando terminar, "pronto".',
      apply: (state, text, today) => {
        const parsed = parseExtraGoal(text, today);
        if (!parsed) return null;
        if ('done' in parsed || !('value' in parsed)) return 'ok';
        const exists = state.extraGoals.some(
          (g) => normalizeText(g.name) === normalizeText(parsed.value.name),
        );
        if (!exists) state.extraGoals.push(parsed.value);
        return 'loop';
      },
    },
    {
      id: 'alertas',
      group: 'alertas',
      ask: () =>
        'Por fim, alertas: "todos", "contas" (só contas e orçamento), "resumos" (só semanal e mensal) ou "nenhum". "Pular" mantém como está.',
      apply: (state, text) => {
        const value = clean(text);
        if (SKIP.has(value) && value !== 'nenhum') return 'ok';
        if (!['todos', 'contas', 'resumos', 'nenhum'].includes(value)) return null;
        state.alerts = value as AlertChoice;
        return 'ok';
      },
    },
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
  for (const extra of state.extraIncome) {
    lines.push(
      `• Renda: ${extra.name}${extra.ownerText ? ` de ${extra.ownerText}` : ''} ${formatBRL(extra.amountCents)}${extra.irregular ? ' (irregular, fora da previsão)' : '/mês'}`,
    );
  }
  for (const account of state.accounts) {
    const owner = account.ownerText ? ` de ${account.ownerText}` : '';
    const detail =
      account.kind === 'credit_card'
        ? account.closingDay && account.dueDay
          ? ` (fecha ${account.closingDay}, vence ${account.dueDay})`
          : ' (sem dias de fatura)'
        : account.openingCents === null
          ? ' (saldo não informado)'
          : ` (saldo ${formatBRL(account.openingCents)})`;
    lines.push(`• Conta: ${account.name}${owner}${detail}`);
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
  for (const [memberId, chosen] of Object.entries(state.defaults)) {
    if (chosen.accountName)
      lines.push(`• Conta principal de ${name(memberId)}: ${chosen.accountName}`);
    if (chosen.cardName) lines.push(`• Cartão padrão de ${name(memberId)}: ${chosen.cardName}`);
  }
  for (const extra of state.extraGoals) {
    lines.push(
      `• Meta: ${extra.name}, objetivo ${formatBRL(extra.targetCents)}${extra.deadline ? `, prazo ${extra.deadline}` : ''}`,
    );
  }
  if (state.goal.accountName) lines.push(`• Dinheiro da meta em: ${state.goal.accountName}`);
  if (state.alerts) lines.push(`• Alertas: ${state.alerts}`);
  if (lines.length === 1) lines.push('• Nada informado ainda.');
  const income = totalIncome(state);
  if (income > 0) {
    lines.push(
      `Renda prevista ${formatBRL(income)} − contas fixas ${formatBRL(totalBills(state))} = ${formatBRL(income - totalBills(state))} por mês antes de lazer, compras e da meta.`,
    );
  }
  lines.push(
    'Para corrigir uma etapa: /configurar renda, contas, fixas, orcamento, apartamento ou alertas.',
  );
  return lines.join('\n');
}

/** O que no rascunho conflita com o cadastro atual: mostrado antes de qualquer alteracao. */
async function contradictions(deps: Deps, actor: Actor, state: OnboardingState): Promise<string[]> {
  const notes: string[] = [];
  for (const account of state.accounts) {
    const found = actor.scope.accounts.find(
      (a) =>
        a.normalizedName === normalizeText(account.name) &&
        a.ownerMemberId === draftOwner(actor, account) &&
        (a.kind === 'credit_card') === (account.kind === 'credit_card'),
    );
    if (found) notes.push(`${found.name} já existe: mantenho o cadastro atual, sem alterar.`);
  }
  if (Object.keys(state.income).length > 0) {
    const entries = await deps.db
      .select()
      .from(recurringEntries)
      .where(
        and(
          eq(recurringEntries.householdId, actor.scope.household.id),
          eq(recurringEntries.kind, 'income'),
          eq(recurringEntries.active, true),
        ),
      );
    for (const [memberId, income] of Object.entries(state.income)) {
      const current = entries.find(
        (e) => e.memberId === memberId && e.normalizedDescription === 'salario',
      );
      if (current && current.amountCents !== null && current.amountCents !== income.amountCents) {
        const member = actor.scope.members.find((m) => m.id === memberId);
        notes.push(
          `Renda de ${member?.name}: hoje é ${formatBRL(current.amountCents)}; vou trocar para ${formatBRL(income.amountCents)}.`,
        );
      }
    }
  }
  const { accountName, savedCents } = state.goal;
  if (accountName && savedCents) {
    const place = locationOptions(actor, state).find((o) => o.label === accountName);
    const opening =
      actor.scope.accounts.find((a) => a.name === place?.name && a.ownerMemberId === place.ownerId)
        ?.openingBalanceCents ??
      state.accounts.find((a) => a.name === place?.name && draftOwner(actor, a) === place.ownerId)
        ?.openingCents ??
      null;
    if (opening !== null && opening < savedCents) {
      notes.push(
        `${formatBRL(savedCents)} reservados em ${accountName}, mas o saldo informado é ${formatBRL(opening)}.`,
      );
    }
  }
  const income = totalIncome(state);
  const limits = Object.values(state.budgets).reduce((sum, c) => sum + c, 0);
  if (income > 0 && limits > income - totalBills(state)) {
    notes.push(
      `Os limites somam ${formatBRL(limits)}, mais do que sobra depois das contas fixas (${formatBRL(income - totalBills(state))}).`,
    );
  }
  return notes.map((note) => `⚠️ ${note}`);
}

async function ask(deps: Deps, actor: Actor, state: OnboardingState, prefix = ''): Promise<Effect> {
  const steps = buildSteps(actor);
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
          text: [
            `${prefix}${summary(state, actor.scope.members)}`,
            ...(await contradictions(deps, actor, state)),
            'Confirma?',
          ].join('\n'),
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
      `${await onboardingChecklist(deps, actor)}\n\nO cadastro guiado já foi concluído. Para refazer: /configurar refazer. Para ajustar uma parte: /configurar renda, contas, fixas, orcamento, apartamento ou alertas.`,
    );
  }
  const state = session.state;
  if ((GROUPS as string[]).includes(option)) {
    const steps = buildSteps(actor);
    const ids = new Set(steps.filter((s) => s.group === option).map((s) => s.id));
    state.answered = state.answered.filter((id) => !ids.has(id));
    if (option === 'contas') {
      state.accounts = [];
      state.defaults = {};
    }
    if (option === 'fixas') state.bills = [];
    if (option === 'orcamento') state.budgets = {};
    if (option === 'apartamento') {
      state.goal = {};
      state.extraGoals = [];
    }
    if (option === 'alertas') delete state.alerts;
    if (option === 'renda') {
      state.income = {};
      state.extraIncome = [];
    }
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
  const steps = buildSteps(actor);
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

  const alertPresets: Record<AlertChoice, Partial<HouseholdSettings['notifications']>> = {
    todos: {
      enabled: true,
      billReminders: true,
      budgetAlerts: true,
      weeklySummary: true,
      monthlyClosing: true,
      goalFollowUp: true,
      behavioralTips: true,
    },
    contas: {
      enabled: true,
      billReminders: true,
      budgetAlerts: true,
      weeklySummary: false,
      monthlyClosing: false,
      goalFollowUp: false,
      behavioralTips: false,
    },
    resumos: {
      enabled: true,
      billReminders: false,
      budgetAlerts: false,
      weeklySummary: true,
      monthlyClosing: true,
      goalFollowUp: false,
      behavioralTips: false,
    },
    nenhum: { enabled: false },
  };
  if (state.tone || state.alerts) {
    const settings = {
      ...actor.scope.settings,
      ...(state.tone ? { tone: state.tone } : {}),
      notifications: {
        ...actor.scope.settings.notifications,
        ...(state.alerts ? alertPresets[state.alerts] : {}),
      },
    };
    statements.push(
      deps.db
        .update(households)
        .set({ settings: JSON.stringify(settings) })
        .where(eq(households.id, actor.scope.household.id)),
    );
  }

  // O mesmo nome pode existir para pessoas diferentes: a identidade inclui o dono.
  const idByKey = new Map(
    actor.scope.accounts.map((a) => [
      accountKey(a.ownerMemberId, a.kind === 'credit_card', a.name),
      a.id,
    ]),
  );
  const existingIdentity = new Set(actor.scope.accounts.map((a) => a.identityKey));
  const skipped: string[] = [];
  const hasDefault = (memberId: string, card: boolean) => {
    const member = actor.scope.members.find((m) => m.id === memberId);
    const preferences = parseMemberPreferences(member?.preferences ?? '{}');
    return Boolean(card ? preferences.defaultCardId : preferences.defaultAccountId);
  };
  for (const account of state.accounts) {
    const ownerId = draftOwner(actor, account);
    const identity = accountIdentityKey(
      ownerId ? 'member' : 'shared',
      ownerId,
      account.kind,
      normalizeText(account.name),
    );
    if (existingIdentity.has(identity)) {
      skipped.push(account.name);
      continue;
    }
    const card = account.kind === 'credit_card';
    const chosen = ownerId ? state.defaults[ownerId]?.[card ? 'cardName' : 'accountName'] : null;
    const accepted = account.kind !== 'reserve' && account.kind !== 'joint';
    const isDefault =
      ownerId !== null &&
      accepted &&
      (chosen
        ? normalizeText(chosen) === normalizeText(account.name)
        : !hasDefault(ownerId, card) && eligibleNames(actor, state, ownerId, card).length === 1);
    const id = deps.newId();
    idByKey.set(accountKey(ownerId, card, account.name), id);
    collect(
      await addAccount(deps, actor, {
        id,
        kind: account.kind,
        name: account.name,
        openingText: money(account.openingCents ?? undefined),
        isDefault,
        closingDay: account.closingDay,
        dueDay: account.dueDay,
        ownerText: account.ownerText ?? null,
      }),
      account.name,
    );
  }
  // Escolha de uma conta que ja existia antes do cadastro.
  for (const [memberId, chosen] of Object.entries(state.defaults)) {
    for (const [name, key] of [
      [chosen.accountName, 'defaultAccountId'],
      [chosen.cardName, 'defaultCardId'],
    ] as const) {
      const account = name
        ? actor.scope.accounts.find((a) => a.name === name && a.ownerMemberId === memberId)
        : undefined;
      if (account) statements.push(setMemberDefaultStatement(deps, memberId, key, account.id));
    }
  }
  for (const [memberId, income] of Object.entries(state.income)) {
    const member = actor.scope.members.find((m) => m.id === memberId);
    if (!member) continue;
    const options = eligibleNames(actor, state, memberId, false);
    const accountName = income.accountName ?? (options.length === 1 ? options[0] : undefined);
    collect(
      await addCommitment(deps, actor, {
        kind: 'income',
        description: 'Salário',
        amountText: formatBRL(income.amountCents).replace('R$ ', ''),
        scheduleType: income.scheduleType ?? 'monthly_unspecified',
        scheduleValue: income.scheduleValue ?? null,
        personText: member.name,
        categoryText: 'salario',
        accountId: accountName
          ? (idByKey.get(accountKey(memberId, false, accountName)) ?? null)
          : null,
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
  for (const extra of state.extraIncome) {
    collect(
      await addCommitment(deps, actor, {
        kind: 'income',
        description: extra.name,
        amountText: formatBRL(extra.amountCents).replace('R$ ', ''),
        scheduleType: extra.irregular ? 'monthly_unspecified' : extra.scheduleType,
        scheduleValue: extra.irregular ? null : extra.scheduleValue,
        personText: extra.ownerText ?? actor.member.name,
        categoryText: null,
        frequency: extra.irregular ? 'irregular' : 'monthly',
      }),
      `renda ${extra.name}`,
    );
  }
  const goal = state.goal;
  const goalPlace = locationOptions(actor, state).find((o) => o.label === goal.accountName);
  if (Object.keys(goal).length > 0) {
    collect(
      await updateApartmentGoal(deps, actor, {
        entry: money(goal.entryCents),
        additionalCosts: money(goal.costsCents),
        deadline: goal.deadline ?? null,
        plannedMonthly: money(goal.monthlyCents),
        emergencyReserve: money(goal.reserveCents),
        initialConfirmed: goal.savedCents ? money(goal.savedCents) : null,
        linkedAccountId: goalPlace
          ? (idByKey.get(accountKey(goalPlace.ownerId, false, goalPlace.name)) ?? null)
          : null,
      }),
      'meta',
    );
  }
  for (const extra of state.extraGoals) {
    collect(
      await createGoal(deps, actor, {
        name: extra.name,
        targetText: formatBRL(extra.targetCents).replace('R$ ', ''),
        deadlineText: extra.deadline,
      }),
      `meta ${extra.name}`,
    );
  }
  statements.push(
    saveStatement(deps, actor, 'completed', state),
    auditStatement(deps, actor, 'onboarding.completed', 'household', actor.scope.household.id, {}),
  );
  const text = [
    'Configuração ativada ✅',
    ...(problems.length ? ['Não consegui aplicar:', ...problems.map((p) => `• ${p}`)] : []),
    ...(skipped.length ? [`Já existiam e ficaram como estavam: ${skipped.join(', ')}.`] : []),
    'Veja o que ainda falta com /configurar status. A partir daqui é só lançar os gastos normalmente.',
  ].join('\n');
  return { statements, replies: [{ text }] };
}
