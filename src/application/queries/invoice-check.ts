import type { Invoice } from '../../domain/finance/card-cycle';
import { cycleClosingIn } from '../../domain/finance/card-cycle';
import { defaultCreditCard, isBareCardHint, matchAccount } from '../../domain/finance/transactions';
import { addDays, addMonths, formatShortDate } from '../../shared/dates';
import { formatBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import type { Account, Actor, Deps } from '../context';
import { ledgerContext } from '../context';
import type { CardInvoiceItem, CardStatement } from './cards';
import { cardDays, cardStatement, dueShiftNote } from './cards';
import { shortId } from './finance';

const MAX_ITEMS = 25;

type CardLookup = { card: Account } | { error: string };

/** Cartao citado, ou o padrao de quem pergunta, ou o unico cadastrado. Nunca adivinha entre varios. */
export function resolveCard(actor: Actor, cardText: string | null): CardLookup {
  const cards = actor.scope.accounts.filter((a) => a.kind === 'credit_card');
  if (cards.length === 0) {
    return {
      error: 'Nenhum cartão cadastrado. Cadastre com /addconta cartao Nome fecha=3 vence=10.',
    };
  }
  const names = cards.map((c) => c.name).join(', ');
  const context = ledgerContext(actor);
  const hint = cardText && !isBareCardHint(cardText) ? cardText : null;
  if (hint) {
    const match = matchAccount(hint, context.accounts, { memberId: actor.member.id, only: 'card' });
    if (match.status === 'found') return { card: cards.find((c) => c.id === match.account.id)! };
    if (match.status === 'ambiguous') {
      return { error: `Qual cartão? ${match.options.map((a) => a.name).join(', ')}.` };
    }
    if (match.status === 'not_found') {
      return { error: `Não achei o cartão "${hint}". Cartões: ${names}.` };
    }
  }
  const member = context.members.find((m) => m.id === actor.member.id);
  const fallback = member ? defaultCreditCard(member, context.accounts) : null;
  if (fallback?.status === 'found')
    return { card: cards.find((c) => c.id === fallback.account.id)! };
  if (cards.length === 1) return { card: cards[0]! };
  return { error: `De qual cartão? ${names}. Exemplo: /fatura ${cards[0]!.name} 300` };
}

function chooseInvoice(invoices: readonly Invoice[], amountCents: number): Invoice | null {
  const visible = invoices.filter((i) => i.status !== 'future');
  const exact = visible.filter((i) => i.totalCents === amountCents);
  if (exact.length === 1) return exact[0]!;
  const closed = visible.filter((i) => i.status !== 'current');
  const lastClosed = closed.at(-1);
  const current = visible.find((i) => i.status === 'current');
  if (lastClosed && lastClosed.remainingCents > 0) return lastClosed;
  return current ?? lastClosed ?? null;
}

const itemLine = (item: CardInvoiceItem) =>
  `• ${formatShortDate(item.date)} ${item.description}: ${formatBRL(item.amountCents)}${item.transactionId ? ` · #${shortId(item.transactionId)}` : ''}`;

const code = (item: CardInvoiceItem) =>
  item.transactionId ? `#${shortId(item.transactionId)}` : 'saldo informado';

/** Pistas deterministicas para a diferenca: nada e alterado sem o usuario pedir. */
function differenceHints(
  statement: CardStatement,
  invoice: Invoice,
  items: readonly CardInvoiceItem[],
  differenceCents: number,
): string[] {
  const card = statement.card.name;
  const hints: string[] = [];
  if (differenceCents > 0) {
    const nextPeriod = addMonths(invoice.closingPeriod, 1);
    const moved = statement.items.find(
      (i) => i.closingPeriod === nextPeriod && i.amountCents === differenceCents,
    );
    if (moved) {
      hints.push(
        `${moved.description} (${formatShortDate(moved.date)}, ${code(moved)}) tem exatamente a diferença e está na próxima fatura, porque foi no dia do fechamento ou depois. Se o banco pôs nesta, o fechamento foi outro dia.`,
      );
    }
    hints.push(
      `Faltou compra? Lance com a data dela: /gasto 30 padaria @${card} ${formatShortDate(addDays(invoice.closingDate, -3))}.`,
      `Juros, IOF, anuidade ou multa também entram: /gasto 12,90 juros @${card}.`,
    );
  } else {
    const extra = -differenceCents;
    const same = items.find((i) => i.amountCents === extra);
    if (same) {
      hints.push(
        `${same.description} (${code(same)}) tem exatamente a diferença. Se não está na fatura do banco, pode ter caído em outra fatura ou ser duplicado.`,
      );
    }
    const seen = new Map<string, CardInvoiceItem>();
    for (const item of items) {
      const key = `${item.date}|${item.amountCents}|${normalizeText(item.description)}`;
      const first = seen.get(key);
      if (first && item.transactionId && first.transactionId) {
        hints.push(`Parece duplicado: ${item.description} ${code(first)} e ${code(item)}.`);
      } else {
        seen.set(key, item);
      }
    }
    hints.push(
      'Lançamento a mais ou errado: /estornar CODIGO apaga, /corrigir CODIGO valor 30 corrige.',
    );
  }
  return hints;
}

/**
 * Confere o valor que veio na fatura do banco contra as compras registradas no Otto.
 * So le dados: nao lanca, nao paga e nao ajusta nada.
 */
export async function invoiceCheck(
  deps: Deps,
  actor: Actor,
  cardText: string | null,
  amountCents: number,
): Promise<string> {
  const lookup = resolveCard(actor, cardText);
  if ('error' in lookup) return lookup.error;
  const { card } = lookup;
  const statement = await cardStatement(deps.db, actor.scope, card, actor.today);
  if (!statement) {
    return `Para conferir preciso dos dias do cartão: /editconta ${card.name} fecha=3 vence=10.`;
  }
  const invoice = chooseInvoice(statement.invoices, amountCents);
  if (!invoice) return `Não há fatura de ${card.name} para conferir ainda.`;

  const isOpen = invoice.status === 'current';
  const items = statement.items
    .filter((i) => i.closingPeriod === invoice.closingPeriod)
    .sort((a, b) => a.date.localeCompare(b.date));
  const older = statement.invoices.filter(
    (i) => i.closingPeriod < invoice.closingPeriod && i.remainingCents > 0,
  );
  const olderCents = older.reduce((sum, i) => sum + i.remainingCents, 0);
  const difference = amountCents - invoice.totalCents;
  const withOlder = olderCents > 0 && amountCents === invoice.totalCents + olderCents;

  const lines = [
    `🧾 ${card.name}: fatura que vence ${formatShortDate(invoice.dueDate)} (${isOpen ? 'fecha' : 'fechou'} ${formatShortDate(invoice.closingDate)})`,
  ];
  const previous = cycleClosingIn(addMonths(invoice.closingPeriod, -1), cardDays(card)!);
  lines.push(
    `Pega as compras de ${formatShortDate(previous.closingDate)} a ${formatShortDate(addDays(invoice.closingDate, -1))}.`,
  );
  if (isOpen) {
    lines.push('Ela ainda está aberta: compras até o fechamento ainda entram.');
  }
  if (difference === 0) {
    lines.push(`✅ Confere: você informou ${formatBRL(amountCents)} e tenho o mesmo valor.`);
  } else if (withOlder) {
    lines.push(
      `✅ Confere somando ${formatBRL(olderCents)} de faturas anteriores que ainda estão em aberto aqui.`,
    );
  } else {
    lines.push(
      `Você informou ${formatBRL(amountCents)}; aqui tenho ${formatBRL(invoice.totalCents)}.`,
      difference > 0
        ? `Faltam ${formatBRL(difference)} registrados aqui.`
        : `Tenho ${formatBRL(-difference)} a mais que a fatura.`,
    );
  }
  if (invoice.status === 'paid' && invoice.totalCents > 0) {
    lines.push('Essa fatura já está paga aqui ✅');
  } else if (invoice.paidCents > 0) {
    lines.push(
      `Já pago: ${formatBRL(invoice.paidCents)}; falta ${formatBRL(invoice.remainingCents)}.`,
    );
  }
  if (invoice.dueDate !== invoice.nominalDueDate) lines.push(dueShiftNote(invoice));

  if (items.length === 0) {
    lines.push('Não há compras registradas nessa fatura.');
  } else {
    lines.push('', 'Compras nesta fatura:', ...items.slice(0, MAX_ITEMS).map(itemLine));
    if (items.length > MAX_ITEMS) lines.push(`• … e mais ${items.length - MAX_ITEMS}.`);
  }
  if (difference !== 0 && !withOlder) {
    lines.push('', ...differenceHints(statement, invoice, items, difference));
    lines.push(
      `Depois de ajustar, confira de novo: /fatura ${card.name} ${formatBRL(amountCents).replace('R$ ', '')}`,
    );
  } else if (invoice.remainingCents > 0 || withOlder) {
    lines.push('', `Quando pagar, me avise: "paguei a fatura do ${card.name}".`);
  }
  return lines.join('\n');
}
