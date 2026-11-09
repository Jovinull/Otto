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
  /** Conta escolhida numa resposta: evita reinterpretar o nome quando ha homonimos. */
  sourceAccountId?: string;
  destinationAccountId?: string;
  /** O usuario respondeu que o gasto nao saiu de nenhuma conta cadastrada. */
  noAccount?: boolean;
}

export interface LedgerMember {
  id: string;
  name: string;
  defaultAccountId?: string | undefined;
  defaultCardId?: string | undefined;
}

export type AccountOwnership = 'member' | 'shared' | 'unassigned';

export interface LedgerAccount {
  id: string;
  name: string;
  normalizedName: string;
  kind: AccountKind;
  ownerMemberId: string | null;
  ownership: AccountOwnership;
  sharedFallback: boolean;
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
  'banco',
]);

const CARD_WORDS = new Set(['cartao', 'credito']);

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

export interface MatchOptions {
  /** Pessoa cujas contas tem preferencia quando ha nomes iguais. */
  memberId?: string | undefined;
  only?: 'card' | 'cash' | undefined;
}

function hintWords(hint: string): string[] {
  return normalizeText(hint).split(' ').filter(Boolean);
}

function coreWords(hint: string): string[] {
  return hintWords(hint).filter((w) => !GENERIC_ACCOUNT_WORDS.has(w) && !CARD_WORDS.has(w));
}

export function hintSignalsCard(hint: string | null): boolean {
  return hint !== null && hintWords(hint).some((w) => CARD_WORDS.has(w));
}

/** "no cartao", "no credito": fala do meio de pagamento, sem dizer qual cartao. */
export function isBareCardHint(hint: string | null): boolean {
  return hint !== null && hintSignalsCard(hint) && coreWords(hint).length === 0;
}

const isCard = (account: LedgerAccount): boolean => account.kind === 'credit_card';

/** Com nomes iguais, vale primeiro a conta da pessoa, depois a do casal. */
function rankByOwner(candidates: LedgerAccount[], memberId: string | undefined): LedgerAccount[] {
  if (!memberId || candidates.length < 2) return candidates;
  const own = candidates.filter((a) => a.ownerMemberId === memberId);
  if (own.length > 0) return own;
  const shared = candidates.filter((a) => a.ownership === 'shared');
  return shared.length > 0 ? shared : candidates;
}

export function matchAccount(
  hint: string | null,
  accounts: readonly LedgerAccount[],
  options: MatchOptions = {},
): AccountMatch {
  if (!hint) return { status: 'no_hint' };
  const words = hintWords(hint);
  const tokens = coreWords(hint);
  const cardSignal = hintSignalsCard(hint);
  if (tokens.length === 0 && !cardSignal) return { status: 'no_hint' };

  const onlyClass = cardSignal
    ? 'card'
    : words.includes('conta') || words.includes('debito') || words.includes('pix')
      ? 'cash'
      : options.only;
  const pool = accounts.filter((a) =>
    onlyClass === 'card' ? isCard(a) : onlyClass === 'cash' ? !isCard(a) : true,
  );

  let candidates: LedgerAccount[];
  if (tokens.length === 0) {
    candidates = pool;
  } else {
    const text = tokens.join(' ');
    candidates = pool.filter((a) => a.normalizedName === text);
    if (candidates.length === 0) {
      candidates = pool.filter((a) =>
        tokens.every((token) => a.normalizedName.split(' ').includes(token)),
      );
    }
    if (candidates.length === 0) {
      // "MercadoPago" e "Mercado Pago" sao a mesma conta.
      const compact = tokens.join('');
      candidates = pool.filter((a) => a.normalizedName.replaceAll(' ', '') === compact);
    }
    // Palavra generica sozinha aponta o tipo; com outras palavras, e o nome de outra conta.
    if (candidates.length === 0 && tokens.length === 1) {
      if (tokens.some((t) => ['reserva', 'poupanca', 'cofre', 'cofrinho'].includes(t))) {
        candidates = pool.filter((a) => a.kind === 'reserve' || a.kind === 'savings');
      } else if (tokens.includes('dinheiro') || tokens.includes('especie')) {
        candidates = pool.filter((a) => a.kind === 'cash');
      } else if (tokens.includes('conjunta')) {
        candidates = pool.filter((a) => a.kind === 'joint');
      }
    }
  }

  const ranked = rankByOwner(candidates, options.memberId);
  if (ranked.length === 1) return { status: 'found', account: ranked[0]! };
  if (ranked.length > 1) return { status: 'ambiguous', options: ranked };
  return { status: 'not_found' };
}

/** Chave de unicidade: pessoas diferentes podem ter contas com o mesmo nome. */
export function accountIdentityKey(
  ownership: AccountOwnership,
  ownerMemberId: string | null,
  kind: AccountKind,
  normalizedName: string,
): string {
  const owner = ownerMemberId ?? (ownership === 'shared' ? 'shared' : 'unassigned');
  return `${owner}|${kind === 'credit_card' ? 'card' : 'cash'}|${normalizedName}`;
}

type DefaultAccount =
  | { status: 'found'; account: LedgerAccount }
  | { status: 'none_configured' }
  | { status: 'ambiguous' };

const belongsToOther = (account: LedgerAccount, member: LedgerMember): boolean =>
  account.ownership === 'member' && account.ownerMemberId !== member.id;

const DAILY_KINDS: readonly AccountKind[] = ['checking', 'joint'];

/**
 * Regra de conta para Pix, debito e movimentacao do dia a dia, em ordem:
 * padrao individual, unica conta propria, conta do casal marcada como alternativa.
 * Conta pessoal da outra pessoa nunca e escolhida sozinha.
 */
export function defaultCashAccount(
  member: LedgerMember,
  accounts: readonly LedgerAccount[],
): DefaultAccount {
  const spendable = accounts.filter((a) => !isCard(a) && a.kind !== 'reserve');
  if (spendable.length === 0) return { status: 'none_configured' };
  if (member.defaultAccountId) {
    const preferred = spendable.find((a) => a.id === member.defaultAccountId);
    if (preferred && !belongsToOther(preferred, member)) {
      return { status: 'found', account: preferred };
    }
  }
  const own = spendable.filter((a) => a.ownerMemberId === member.id);
  const ownDaily = own.filter((a) => DAILY_KINDS.includes(a.kind));
  if (ownDaily.length === 1) return { status: 'found', account: ownDaily[0]! };
  if (ownDaily.length === 0 && own.length === 1) return { status: 'found', account: own[0]! };
  if (own.length > 1) return { status: 'ambiguous' };
  const fallback = spendable.filter((a) => a.ownership === 'shared' && a.sharedFallback);
  if (fallback.length === 1) return { status: 'found', account: fallback[0]! };
  return { status: 'ambiguous' };
}

type DefaultCard =
  | { status: 'found'; account: LedgerAccount }
  | { status: 'none_configured' }
  | { status: 'ambiguous'; options: LedgerAccount[] };

/** Cartao de quem fez a compra: padrao individual, unico proprio, unico do casal. */
export function defaultCreditCard(
  member: LedgerMember,
  accounts: readonly LedgerAccount[],
): DefaultCard {
  const cards = accounts.filter(isCard);
  if (cards.length === 0) return { status: 'none_configured' };
  if (member.defaultCardId) {
    const preferred = cards.find((a) => a.id === member.defaultCardId);
    if (preferred && !belongsToOther(preferred, member)) {
      return { status: 'found', account: preferred };
    }
  }
  const own = cards.filter((a) => a.ownerMemberId === member.id);
  if (own.length === 1) return { status: 'found', account: own[0]! };
  if (own.length > 1) return { status: 'ambiguous', options: own };
  const shared = cards.filter((a) => a.ownership === 'shared');
  if (shared.length === 1) return { status: 'found', account: shared[0]! };
  return { status: 'ambiguous', options: shared.length > 0 ? shared : cards };
}

function accountLabel(account: LedgerAccount, context: LedgerContext): string {
  const owner = account.ownerMemberId
    ? context.members.find((m) => m.id === account.ownerMemberId)?.name
    : account.ownership === 'shared'
      ? 'casal'
      : undefined;
  const details = [isCard(account) ? 'cartão' : null, owner].filter(Boolean).join(', ');
  return details ? `${account.name} (${details})` : account.name;
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

function missingAccountQuestion(
  prefix: string,
  accounts: readonly LedgerAccount[],
  context: LedgerContext,
): string {
  return `${prefix} Opções: ${accounts.map((a) => accountLabel(a, context)).join(', ')}.`;
}

/** "minha conta principal" e o padrao da pessoa, a menos que exista conta com esse nome. */
function expandPrincipal(
  draft: TransactionDraft,
  member: LedgerMember,
  context: LedgerContext,
): TransactionDraft {
  const preferred = context.accounts.find((a) => a.id === member.defaultAccountId);
  if (!preferred) return draft;
  const named = context.accounts.some((a) => a.normalizedName === 'principal');
  const expand = (hint: string | null) =>
    !named && hint && coreWords(hint).join(' ') === 'principal' ? preferred.name : hint;
  return {
    ...draft,
    sourceAccountText: expand(draft.sourceAccountText),
    destinationAccountText: expand(draft.destinationAccountText),
  };
}

/** Contas que fazem sentido oferecer: as da pessoa e do casal; se nao houver, todas. */
function eligibleFor(
  member: LedgerMember,
  accounts: readonly LedgerAccount[],
): readonly LedgerAccount[] {
  const mine = accounts.filter((a) => !belongsToOther(a, member));
  return mine.length > 0 ? mine : accounts;
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
  const wantsCredit =
    draft.paymentMethod === 'credit' ||
    draft.installments !== null ||
    hintSignalsCard(draft.sourceAccountText);

  if (draft.sourceAccountId) {
    const chosen = context.accounts.find((a) => a.id === draft.sourceAccountId);
    if (chosen) return { choice: { account: chosen, isCredit: isCard(chosen) } };
  }
  if (draft.noAccount && !wantsCredit) return { choice: { account: null, isCredit: false } };

  const hint = isBareCardHint(draft.sourceAccountText) ? null : draft.sourceAccountText;
  const only =
    draft.paymentMethod === 'debit' ||
    draft.paymentMethod === 'pix' ||
    draft.paymentMethod === 'cash'
      ? 'cash'
      : wantsCredit
        ? 'card'
        : undefined;
  const match = matchAccount(hint, context.accounts, { memberId: member.id, only });
  if (match.status === 'found') {
    return { choice: { account: match.account, isCredit: isCard(match.account) } };
  }
  if (match.status === 'ambiguous') {
    return {
      outcome: needs(
        'source_account',
        missingAccountQuestion(
          wantsCredit ? 'Em qual cartão?' : 'De qual conta saiu?',
          match.options,
          context,
        ),
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
          `Não achei "${draft.sourceAccountText}". ${wantsCredit ? 'Em qual cartão?' : 'De qual conta saiu?'}`,
          context.accounts.filter((a) => (wantsCredit ? isCard(a) : true)),
          context,
        ),
      ),
    };
  }

  if (wantsCredit) {
    const card = defaultCreditCard(member, context.accounts);
    if (card.status === 'found') return { choice: { account: card.account, isCredit: true } };
    if (card.status === 'none_configured') {
      return {
        outcome: rejected(
          'Compra no cartão ou parcelada precisa de um cartão cadastrado, senão a fatura fica errada. Cadastre com /addconta cartao Nome fecha=3 vence=10 e mande de novo.',
        ),
      };
    }
    return {
      outcome: needs(
        'source_account',
        missingAccountQuestion('Em qual cartão?', card.options, context),
      ),
    };
  }

  if (draft.paymentMethod === 'cash') {
    const cash = eligibleFor(
      member,
      context.accounts.filter((a) => a.kind === 'cash'),
    ).filter((a) => !belongsToOther(a, member));
    if (cash.length === 1) return { choice: { account: cash[0]!, isCredit: false } };
  }

  const fallback = defaultCashAccount(member, context.accounts);
  if (fallback.status === 'found') {
    return { choice: { account: fallback.account, isCredit: false } };
  }
  if (fallback.status === 'none_configured') return { choice: { account: null, isCredit: false } };
  return {
    outcome: needs(
      'source_account',
      `${missingAccountQuestion(
        'De qual conta saiu?',
        eligibleFor(
          member,
          context.accounts.filter((a) => !isCard(a) && a.kind !== 'reserve'),
        ),
        context,
      )} Se não saiu de nenhuma, responda "sem conta".`,
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

  const isPayment = draft.kind === 'card_payment';
  let destination = context.accounts.find((a) => a.id === draft.destinationAccountId);
  let destinationOptions: readonly LedgerAccount[] | null = null;
  if (!destination) {
    const hint =
      isPayment && isBareCardHint(draft.destinationAccountText)
        ? null
        : draft.destinationAccountText;
    let match = matchAccount(hint, context.accounts, {
      memberId: member.id,
      only: isPayment ? 'card' : 'cash',
    });
    if (match.status === 'not_found' && !isPayment) {
      match = matchAccount(hint, context.accounts, { memberId: member.id });
    }
    if (match.status === 'found') destination = match.account;
    else if (match.status === 'ambiguous') destinationOptions = match.options;
    else if (match.status === 'no_hint' && isPayment) {
      const card = defaultCreditCard(member, context.accounts);
      if (card.status === 'found') destination = card.account;
      else if (card.status === 'ambiguous') destinationOptions = card.options;
    }
  }
  if (!destination) {
    const options =
      destinationOptions ?? (isPayment ? context.accounts.filter(isCard) : context.accounts);
    if (options.length === 0) {
      return { outcome: rejected('Ainda não há cartão cadastrado. Use /addconta cartao Nome.') };
    }
    return {
      outcome: needs(
        'destination_account',
        missingAccountQuestion(
          isPayment ? 'De qual cartão é a fatura?' : 'Para qual conta foi?',
          options,
          context,
        ),
      ),
    };
  }
  const target = destination;

  let source = context.accounts.find((a) => a.id === draft.sourceAccountId);
  let sourceOptions: readonly LedgerAccount[] | null = null;
  if (!source) {
    const match = matchAccount(
      draft.sourceAccountText,
      context.accounts.filter((a) => a.id !== target.id),
      { memberId: member.id, only: 'cash' },
    );
    if (match.status === 'found') source = match.account;
    else if (match.status === 'ambiguous') sourceOptions = match.options;
    else if (
      match.status === 'not_found' &&
      matchAccount(draft.sourceAccountText, context.accounts, { only: 'card' }).status === 'found'
    ) {
      return { outcome: rejected('Cartão de crédito não pode ser origem de transferência.') };
    } else if (match.status === 'no_hint') {
      const fallback = defaultCashAccount(
        member,
        context.accounts.filter((a) => a.id !== target.id),
      );
      if (fallback.status === 'found') source = fallback.account;
    }
  }
  if (!source) {
    return {
      outcome: needs(
        'source_account',
        missingAccountQuestion(
          'De qual conta saiu?',
          sourceOptions ??
            eligibleFor(
              member,
              context.accounts.filter((a) => !isCard(a) && a.id !== target.id),
            ),
          context,
        ),
      ),
    };
  }

  if (source.id === target.id) {
    return { outcome: rejected('Origem e destino são a mesma conta; não há o que registrar.') };
  }
  if (isCard(source)) {
    return { outcome: rejected('Cartão de crédito não pode ser origem de transferência.') };
  }
  return { source, destination: target };
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
    const accounts = resolveTransferAccounts(
      expandPrincipal(draft, member, context),
      member,
      context,
    );
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
    const incomeOptions = eligibleFor(
      member,
      context.accounts.filter((a) => !isCard(a)),
    );
    const chosen = context.accounts.find((a) => a.id === draft.destinationAccountId);
    const match = matchAccount(
      draft.destinationAccountText ?? draft.sourceAccountText,
      chosen ? [] : context.accounts,
      { memberId: member.id },
    );
    let account: LedgerAccount | null = chosen ?? null;
    if (!chosen && match.status === 'found') account = match.account;
    else if (!chosen && (match.status === 'ambiguous' || match.status === 'not_found')) {
      return needs(
        'destination_account',
        missingAccountQuestion(
          'Em qual conta entrou?',
          match.status === 'ambiguous' ? match.options : incomeOptions,
          context,
        ),
      );
    } else if (!chosen && !draft.noAccount) {
      const fallback = defaultCashAccount(member, context.accounts);
      if (fallback.status === 'ambiguous') {
        return needs(
          'destination_account',
          missingAccountQuestion('Em qual conta entrou?', incomeOptions, context),
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

  const source = resolveExpenseSource(expandPrincipal(draft, member, context), member, context);
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
      if (/^(sem conta|nenhuma|nenhuma delas)$/.test(normalizeText(text))) {
        return draft.kind === 'expense' || draft.kind === 'income'
          ? { ...draft, noAccount: true }
          : null;
      }
      const payer = resolveMember(draft.personText, context);
      const isPayment = draft.kind === 'card_payment';
      const wantsCard =
        slot === 'destination_account'
          ? isPayment
          : draft.paymentMethod === 'credit' || draft.installments !== null;
      const match = matchAccount(text, context.accounts, {
        memberId: 'member' in payer ? payer.member.id : context.senderMemberId,
        only: wantsCard
          ? 'card'
          : slot === 'source_account' && draft.kind === 'expense'
            ? undefined
            : 'cash',
      });
      if (match.status !== 'found') return null;
      return slot === 'source_account'
        ? { ...draft, sourceAccountId: match.account.id }
        : { ...draft, destinationAccountId: match.account.id };
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
