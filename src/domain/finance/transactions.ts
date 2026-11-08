import type { LocalDate } from '../../shared/dates';
import { formatShortDate, resolveDateExpression } from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import { FALLBACK_EXPENSE_SLUG, FALLBACK_INCOME_SLUG, inferCategorySlug } from './categories';

export type AccountKind = 'checking' | 'savings' | 'cash' | 'reserve' | 'joint' | 'credit_card';
export type DraftKind = 'expense' | 'income' | 'transfer' | 'card_payment';
export type PaymentMethod = 'credit' | 'debit' | 'pix' | 'cash' | 'unknown';

/** Intencao de lancamento, ainda sem garantia de correcao. Nunca e persistida como movimentacao. */
export interface TransactionDraft {
  kind: DraftKind;
  amountText: string | null;
  amountCents?: number;
  description: string;
  categorySlug: string | null;
  personText: string | null;
  isShared: boolean;
  sourceAccountText: string | null;
  destinationAccountText: string | null;
  dateText: string | null;
  resolvedDate?: LocalDate;
  paymentMethod: PaymentMethod;
  installments: number | null;
}

export interface LedgerMember {
  id: string;
  name: string;
  defaultAccountId?: string | undefined;
}

export interface LedgerAccount {
  id: string;
  name: string;
  normalizedName: string;
  kind: AccountKind;
  ownerMemberId: string | null;
  isDefault: boolean;
}

export interface LedgerCategory {
  id: string;
  slug: string;
  name: string;
  kind: 'expense' | 'income';
}

export interface LedgerContext {
  members: readonly LedgerMember[];
  accounts: readonly LedgerAccount[];
  categories: readonly LedgerCategory[];
  senderMemberId: string;
  today: LocalDate;
}

export interface ResolvedTransaction {
  type: 'expense' | 'income' | 'transfer';
  transferKind: 'internal' | 'card_payment' | null;
  amountCents: number;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  sourceAccountName: string | null;
  destinationAccountName: string | null;
  memberId: string;
  memberName: string;
  isShared: boolean;
  financialDate: LocalDate;
  isCreditPurchase: boolean;
  installments: number | null;
}

export type Slot = 'amount' | 'date' | 'source_account' | 'destination_account';

export type ResolveOutcome =
  | { status: 'resolved'; transaction: ResolvedTransaction }
  | { status: 'needs_input'; slot: Slot; question: string; candidateCents?: number }
  | { status: 'rejected'; reason: string };

const needs = (slot: Slot, question: string, candidateCents?: number): ResolveOutcome =>
  candidateCents === undefined
    ? { status: 'needs_input', slot, question }
    : { status: 'needs_input', slot, question, candidateCents };

const rejected = (reason: string): ResolveOutcome => ({ status: 'rejected', reason });

const GENERIC_ACCOUNT_WORDS = new Set([
  'conta',
  'minha',
  'meu',
  'da',
  'do',
  'de',
  'na',
  'no',
  'a',
  'o',
  'nossa',
  'nosso',
]);

const PARTNER_WORDS = new Set([
  'ele',
  'ela',
  'esposa',
  'esposo',
  'marido',
  'mulher',
  'namorada',
  'namorado',
  'noiva',
  'noivo',
  'amor',
]);

const SELF_WORDS = new Set(['eu', 'mim', 'meu', 'minha']);

export type AccountMatch =
  | { status: 'found'; account: LedgerAccount }
  | { status: 'no_hint' }
  | { status: 'not_found' }
  | { status: 'ambiguous'; options: LedgerAccount[] };

export function matchAccount(
  hint: string | null,
  accounts: readonly LedgerAccount[],
): AccountMatch {
  if (!hint) return { status: 'no_hint' };
  const tokens = normalizeText(hint)
    .split(' ')
    .filter((token) => token && !GENERIC_ACCOUNT_WORDS.has(token));
  if (tokens.length === 0) return { status: 'no_hint' };
  const text = tokens.join(' ');

  const exact = accounts.filter((account) => account.normalizedName === text);
  if (exact.length === 1) return { status: 'found', account: exact[0]! };

  let candidates = accounts.filter((account) =>
    tokens.every((token) => account.normalizedName.split(' ').includes(token)),
  );
  if (candidates.length === 0) {
    if (tokens.includes('reserva') || tokens.includes('poupanca')) {
      candidates = accounts.filter((a) => a.kind === 'reserve' || a.kind === 'savings');
    } else if (tokens.includes('cartao') || tokens.includes('credito')) {
      candidates = accounts.filter((a) => a.kind === 'credit_card');
    } else if (tokens.includes('dinheiro') || tokens.includes('especie')) {
      candidates = accounts.filter((a) => a.kind === 'cash');
    } else if (tokens.includes('conjunta')) {
      candidates = accounts.filter((a) => a.kind === 'joint');
    }
  }
  if (candidates.length === 1) return { status: 'found', account: candidates[0]! };
  if (candidates.length > 1) return { status: 'ambiguous', options: candidates };
  return { status: 'not_found' };
}

type DefaultAccount =
  | { status: 'found'; account: LedgerAccount }
  | { status: 'none_configured' }
  | { status: 'ambiguous' };

/**
 * Regra explicita de conta padrao, em ordem:
 * preferencia do membro, conta marcada como padrao, unica conta do membro, unica conta da casa.
 */
export function defaultCashAccount(
  member: LedgerMember,
  accounts: readonly LedgerAccount[],
): DefaultAccount {
  const spendable = accounts.filter((a) => a.kind !== 'credit_card' && a.kind !== 'reserve');
  if (member.defaultAccountId) {
    const preferred = spendable.find((a) => a.id === member.defaultAccountId);
    if (preferred) return { status: 'found', account: preferred };
  }
  const markedDefault = spendable.filter((a) => a.isDefault);
  if (markedDefault.length === 1) return { status: 'found', account: markedDefault[0]! };
  const owned = spendable.filter((a) => a.ownerMemberId === member.id);
  if (owned.length === 1) return { status: 'found', account: owned[0]! };
  if (spendable.length === 1) return { status: 'found', account: spendable[0]! };
  return spendable.length === 0 ? { status: 'none_configured' } : { status: 'ambiguous' };
}

function accountList(accounts: readonly LedgerAccount[]): string {
  return accounts.map((a) => a.name).join(', ');
}

type MemberResolution = { member: LedgerMember } | { error: string };

function resolveMember(personText: string | null, context: LedgerContext): MemberResolution {
  const sender = context.members.find((m) => m.id === context.senderMemberId);
  if (!sender) return { error: 'Remetente não pertence a esta família.' };
  if (!personText) return { member: sender };
  const text = normalizeText(personText)
    .replace(/^(o|a)\s+/, '')
    .trim();
  if (text === '' || SELF_WORDS.has(text)) return { member: sender };

  const firstWord = text.split(' ')[0]!;
  const named = context.members.find((m) => normalizeText(m.name).split(' ')[0] === firstWord);
  if (named) return { member: named };

  const words = text.split(' ');
  if (words.some((w) => PARTNER_WORDS.has(w))) {
    const others = context.members.filter((m) => m.id !== sender.id);
    if (others.length === 1) return { member: others[0]! };
  }
  return { error: `Não encontrei "${personText}" entre os membros cadastrados.` };
}

function resolveCategory(
  draft: TransactionDraft,
  kind: 'expense' | 'income',
  context: LedgerContext,
): LedgerCategory | undefined {
  const inKind = context.categories.filter((c) => c.kind === kind);
  const bySlug = inKind.find((c) => c.slug === draft.categorySlug);
  if (bySlug) return bySlug;
  const inferred = inferCategorySlug(draft.description, kind);
  return (
    inKind.find((c) => c.slug === inferred) ??
    inKind.find(
      (c) => c.slug === (kind === 'expense' ? FALLBACK_EXPENSE_SLUG : FALLBACK_INCOME_SLUG),
    )
  );
}

function resolveAmount(draft: TransactionDraft): { cents: number } | { outcome: ResolveOutcome } {
  if (draft.amountCents !== undefined) return { cents: draft.amountCents };
  if (!draft.amountText) {
    return { outcome: needs('amount', `Qual foi o valor de "${draft.description}"?`) };
  }
  const parsed = parseBRL(draft.amountText);
  if (parsed.status === 'ok') return { cents: parsed.cents };
  if (parsed.status === 'ambiguous') {
    return {
      outcome: needs(
        'amount',
        `Só para não anotar errado: "${draft.amountText}" é ${formatBRL(parsed.candidateCents)}? Responda sim ou mande o valor certo, tipo 1.250,00.`,
        parsed.candidateCents,
      ),
    };
  }
  return { outcome: needs('amount', `Não entendi o valor "${draft.amountText}". Qual é o valor?`) };
}

function resolveDate(
  draft: TransactionDraft,
  today: LocalDate,
): { date: LocalDate } | { outcome: ResolveOutcome } {
  if (draft.resolvedDate) return { date: draft.resolvedDate };
  const resolution = resolveDateExpression(draft.dateText ?? '', today);
  if (resolution.status === 'ok') return { date: resolution.date };
  if (resolution.status === 'imprecise') {
    return {
      outcome: needs(
        'date',
        `Em que dia foi, entre ${formatShortDate(resolution.range.from)} e ${formatShortDate(resolution.range.to)}? Pode mandar no formato 03/11.`,
      ),
    };
  }
  return {
    outcome: needs(
      'date',
      'Não entendi a data (ou ela está no futuro). Em que dia foi? Ex.: 03/11.',
    ),
  };
}

function missingAccountQuestion(prefix: string, accounts: readonly LedgerAccount[]): string {
  return `${prefix} Opções: ${accountList(accounts)}.`;
}

interface SourceChoice {
  account: LedgerAccount | null;
  isCredit: boolean;
}

function resolveExpenseSource(
  draft: TransactionDraft,
  member: LedgerMember,
  context: LedgerContext,
): { choice: SourceChoice } | { outcome: ResolveOutcome } {
  const cards = context.accounts.filter((a) => a.kind === 'credit_card');
  const wantsCredit = draft.paymentMethod === 'credit' || (draft.installments ?? 1) > 1;

  const match = matchAccount(draft.sourceAccountText, context.accounts);
  if (match.status === 'found') {
    return { choice: { account: match.account, isCredit: match.account.kind === 'credit_card' } };
  }
  if (match.status === 'ambiguous') {
    return {
      outcome: needs(
        'source_account',
        missingAccountQuestion('De qual conta saiu?', match.options),
      ),
    };
  }
  if (match.status === 'not_found') {
    if (context.accounts.length === 0) {
      return {
        outcome: rejected(
          `Ainda não tenho a conta "${draft.sourceAccountText}" cadastrada. Veja /ajuda contas.`,
        ),
      };
    }
    return {
      outcome: needs(
        'source_account',
        missingAccountQuestion(
          `Não achei a conta "${draft.sourceAccountText}". De qual conta saiu?`,
          context.accounts,
        ),
      ),
    };
  }

  if (wantsCredit) {
    if (cards.length === 1) return { choice: { account: cards[0]!, isCredit: true } };
    if (cards.length === 0) {
      return {
        outcome: rejected(
          'Compra no cartão ou parcelada precisa de um cartão cadastrado, senão a fatura fica errada. Cadastre com /addconta cartao Nome fecha=3 vence=10 e mande de novo.',
        ),
      };
    }
    return { outcome: needs('source_account', missingAccountQuestion('Em qual cartão?', cards)) };
  }

  if (draft.paymentMethod === 'cash') {
    const cash = context.accounts.filter((a) => a.kind === 'cash');
    if (cash.length === 1) return { choice: { account: cash[0]!, isCredit: false } };
  }

  const fallback = defaultCashAccount(member, context.accounts);
  if (fallback.status === 'found')
    return { choice: { account: fallback.account, isCredit: false } };
  if (fallback.status === 'none_configured') return { choice: { account: null, isCredit: false } };
  return {
    outcome: needs(
      'source_account',
      missingAccountQuestion(
        'De qual conta saiu?',
        context.accounts.filter((a) => a.kind !== 'reserve'),
      ),
    ),
  };
}

function resolveTransferAccounts(
  draft: TransactionDraft,
  member: LedgerMember,
  context: LedgerContext,
): { source: LedgerAccount; destination: LedgerAccount } | { outcome: ResolveOutcome } {
  if (context.accounts.length === 0) {
    return {
      outcome: rejected(
        'Para registrar transferência preciso das contas cadastradas. Use /addconta (veja /ajuda contas).',
      ),
    };
  }

  const cards = context.accounts.filter((a) => a.kind === 'credit_card');
  let destination: LedgerAccount | undefined;
  const destinationMatch = matchAccount(draft.destinationAccountText, context.accounts);
  if (destinationMatch.status === 'found') destination = destinationMatch.account;
  else if (draft.kind === 'card_payment' && cards.length === 1) destination = cards[0]!;
  if (!destination) {
    const options = draft.kind === 'card_payment' ? cards : context.accounts;
    if (options.length === 0) {
      return { outcome: rejected('Ainda não há cartão cadastrado. Use /addconta cartao Nome.') };
    }
    return {
      outcome: needs(
        'destination_account',
        missingAccountQuestion(
          draft.kind === 'card_payment' ? 'De qual cartão é a fatura?' : 'Para qual conta foi?',
          options,
        ),
      ),
    };
  }

  const sourceMatch = matchAccount(draft.sourceAccountText, context.accounts);
  let source: LedgerAccount | undefined;
  if (sourceMatch.status === 'found') source = sourceMatch.account;
  else if (sourceMatch.status === 'no_hint') {
    const fallback = defaultCashAccount(
      member,
      context.accounts.filter((a) => a.id !== destination.id),
    );
    if (fallback.status === 'found') source = fallback.account;
  }
  if (!source) {
    return {
      outcome: needs(
        'source_account',
        missingAccountQuestion(
          'De qual conta saiu?',
          context.accounts.filter((a) => a.kind !== 'credit_card' && a.id !== destination.id),
        ),
      ),
    };
  }

  if (source.id === destination.id) {
    return { outcome: rejected('Origem e destino são a mesma conta; não há o que registrar.') };
  }
  if (source.kind === 'credit_card') {
    return { outcome: rejected('Cartão de crédito não pode ser origem de transferência.') };
  }
  return { source, destination };
}

/**
 * Aplica as regras financeiras a um rascunho.
 * Ponto unico por onde qualquer lancamento (comando ou IA) precisa passar.
 */
export function resolveDraft(draft: TransactionDraft, context: LedgerContext): ResolveOutcome {
  const amount = resolveAmount(draft);
  if ('outcome' in amount) return amount.outcome;

  const date = resolveDate(draft, context.today);
  if ('outcome' in date) return date.outcome;

  const resolved = resolveMember(draft.personText, context);
  if ('error' in resolved) return rejected(resolved.error);
  const member = resolved.member;

  const base = {
    amountCents: amount.cents,
    description: draft.description,
    memberId: member.id,
    memberName: member.name,
    isShared: draft.isShared,
    financialDate: date.date,
  };

  if (draft.kind === 'transfer' || draft.kind === 'card_payment') {
    const accounts = resolveTransferAccounts(draft, member, context);
    if ('outcome' in accounts) return accounts.outcome;
    const isCardPayment = accounts.destination.kind === 'credit_card';
    if (draft.kind === 'card_payment' && !isCardPayment) {
      return rejected('O destino de um pagamento de fatura precisa ser um cartão de crédito.');
    }
    return {
      status: 'resolved',
      transaction: {
        ...base,
        type: 'transfer',
        transferKind: isCardPayment ? 'card_payment' : 'internal',
        categoryId: null,
        categoryName: null,
        sourceAccountId: accounts.source.id,
        destinationAccountId: accounts.destination.id,
        sourceAccountName: accounts.source.name,
        destinationAccountName: accounts.destination.name,
        isCreditPurchase: false,
        installments: null,
      },
    };
  }

  if (draft.kind === 'income') {
    const match = matchAccount(
      draft.destinationAccountText ?? draft.sourceAccountText,
      context.accounts,
    );
    let account: LedgerAccount | null = null;
    if (match.status === 'found') account = match.account;
    else if (match.status === 'ambiguous' || match.status === 'not_found') {
      return needs(
        'destination_account',
        missingAccountQuestion(
          'Em qual conta entrou?',
          context.accounts.filter((a) => a.kind !== 'credit_card'),
        ),
      );
    } else {
      const fallback = defaultCashAccount(member, context.accounts);
      if (fallback.status === 'ambiguous') {
        return needs(
          'destination_account',
          missingAccountQuestion(
            'Em qual conta entrou?',
            context.accounts.filter((a) => a.kind !== 'credit_card'),
          ),
        );
      }
      if (fallback.status === 'found') account = fallback.account;
    }
    if (account?.kind === 'credit_card') {
      return rejected('Receita não pode entrar em cartão de crédito.');
    }
    const category = resolveCategory(draft, 'income', context);
    if (!category) return rejected('Categorias de receita não configuradas.');
    return {
      status: 'resolved',
      transaction: {
        ...base,
        type: 'income',
        transferKind: null,
        categoryId: category.id,
        categoryName: category.name,
        sourceAccountId: null,
        destinationAccountId: account?.id ?? null,
        sourceAccountName: null,
        destinationAccountName: account?.name ?? null,
        isCreditPurchase: false,
        installments: null,
      },
    };
  }

  const source = resolveExpenseSource(draft, member, context);
  if ('outcome' in source) return source.outcome;
  const installments =
    draft.installments !== null && draft.installments > 1 ? draft.installments : null;
  if (installments !== null && !source.choice.isCredit) {
    return rejected('Parcelamento só é aceito em cartão de crédito nesta versão.');
  }
  const category = resolveCategory(draft, 'expense', context);
  if (!category) return rejected('Categorias de despesa não configuradas.');
  return {
    status: 'resolved',
    transaction: {
      ...base,
      type: 'expense',
      transferKind: null,
      categoryId: category.id,
      categoryName: category.name,
      sourceAccountId: source.choice.account?.id ?? null,
      destinationAccountId: null,
      sourceAccountName: source.choice.account?.name ?? null,
      destinationAccountName: null,
      isCreditPurchase: source.choice.isCredit,
      installments,
    },
  };
}

/** Preenche uma lacuna com a resposta do usuario. Retorna null se a resposta nao servir. */
export function applySlotAnswer(
  draft: TransactionDraft,
  slot: Slot,
  answer: string,
  context: LedgerContext,
  candidateCents?: number,
): TransactionDraft | null {
  const text = answer.trim();
  switch (slot) {
    case 'amount': {
      if (candidateCents !== undefined && isAffirmative(text)) {
        return { ...draft, amountCents: candidateCents };
      }
      const parsed = parseBRL(text);
      return parsed.status === 'ok' ? { ...draft, amountCents: parsed.cents } : null;
    }
    case 'date': {
      const resolved = resolveDateExpression(text, context.today);
      return resolved.status === 'ok' ? { ...draft, resolvedDate: resolved.date } : null;
    }
    case 'source_account':
    case 'destination_account': {
      const match = matchAccount(text, context.accounts);
      if (match.status !== 'found') return null;
      return slot === 'source_account'
        ? { ...draft, sourceAccountText: match.account.name }
        : { ...draft, destinationAccountText: match.account.name };
    }
  }
}

const AFFIRMATIVE = new Set([
  'sim',
  's',
  'isso',
  'confirmo',
  'confirmar',
  'pode',
  'pode sim',
  'isso mesmo',
  'ok',
  'certo',
]);
const NEGATIVE = new Set(['nao', 'n', 'cancela', 'cancelar', 'deixa', 'deixa pra la', 'esquece']);

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.has(normalizeText(text).replace(/[.!]+$/, ''));
}

export function isNegative(text: string): boolean {
  return NEGATIVE.has(normalizeText(text).replace(/[.!]+$/, ''));
}

/**
 * Confere se o valor extraido pela IA aparece de fato na mensagem.
 * Valores que nao aparecem nunca sao gravados sem confirmacao explicita.
 */
export function amountAppearsInText(amountText: string | null, message: string): boolean {
  if (!amountText) return false;
  const parsed = parseBRL(amountText);
  const target =
    parsed.status === 'ok'
      ? parsed.cents
      : parsed.status === 'ambiguous'
        ? parsed.candidateCents
        : null;
  if (target === null) return false;
  const tokens = normalizeText(message).match(/\d[\d.,]*(?:\s*(?:mil|k)\b)?/g) ?? [];
  return tokens.some((token) => {
    const candidate = parseBRL(token.replace(/[.,]$/, ''));
    return (
      (candidate.status === 'ok' && candidate.cents === target) ||
      (candidate.status === 'ambiguous' && candidate.candidateCents === target)
    );
  });
}
