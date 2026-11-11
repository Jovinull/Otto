import { and, eq, inArray } from 'drizzle-orm';
import type { CardDays, Charge, Invoice } from '../../domain/finance/card-cycle';
import {
  buildInvoices,
  cycleForInstallment,
  cycleForPurchase,
} from '../../domain/finance/card-cycle';
import type { Db } from '../../infrastructure/database/client';
import {
  financialTransactions as tx,
  installmentPlans,
  installments,
} from '../../infrastructure/database/schema';
import type { LocalDate } from '../../shared/dates';
import { formatShortDate, monthName, weekdayOf } from '../../shared/dates';
import { formatBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import type { Account, Scope } from '../context';

export function cardDays(card: Account): CardDays | null {
  return card.creditClosingDay !== null && card.creditDueDay !== null
    ? { closingDay: card.creditClosingDay, dueDay: card.creditDueDay }
    : null;
}

export interface CardStatement {
  card: Account;
  invoices: Invoice[];
  creditCents: number;
  items: CardInvoiceItem[];
}

export interface CardInvoiceItem {
  /** Lancamento de origem; null para o saldo devedor informado no cadastro. */
  transactionId: string | null;
  closingPeriod: string;
  date: LocalDate;
  description: string;
  amountCents: number;
}

/** Faturas de um cartao a partir das compras, parcelas e pagamentos confirmados. */
export async function cardStatement(
  db: Db,
  scope: Scope,
  card: Account,
  today: LocalDate,
): Promise<CardStatement | null> {
  const days = cardDays(card);
  if (!days) return null;
  const householdId = scope.household.id;
  const [purchases, payments] = await db.batch([
    db
      .select({
        id: tx.id,
        amountCents: tx.amountCents,
        date: tx.financialDate,
        description: tx.description,
      })
      .from(tx)
      .where(
        and(
          eq(tx.householdId, householdId),
          eq(tx.status, 'confirmed'),
          eq(tx.type, 'expense'),
          eq(tx.sourceAccountId, card.id),
        ),
      ),
    db
      .select({ amountCents: tx.amountCents, date: tx.financialDate })
      .from(tx)
      .where(
        and(
          eq(tx.householdId, householdId),
          eq(tx.status, 'confirmed'),
          eq(tx.type, 'transfer'),
          eq(tx.destinationAccountId, card.id),
        ),
      ),
  ]);

  const purchaseIds = purchases.map((p) => p.id);
  const parts =
    purchaseIds.length === 0
      ? []
      : await db
          .select({
            transactionId: installmentPlans.transactionId,
            sequence: installments.sequence,
            amountCents: installments.amountCents,
            installmentCount: installmentPlans.installmentCount,
          })
          .from(installments)
          .innerJoin(installmentPlans, eq(installments.planId, installmentPlans.id))
          .where(
            and(
              inArray(installmentPlans.transactionId, purchaseIds),
              eq(installmentPlans.status, 'active'),
            ),
          );

  const split = new Set(parts.map((p) => p.transactionId));
  const byId = new Map(purchases.map((p) => [p.id, p]));
  const items: CardInvoiceItem[] = [
    ...purchases
      .filter((p) => !split.has(p.id))
      .map((p) => ({
        transactionId: p.id,
        closingPeriod: cycleForPurchase(p.date, days).closingPeriod,
        date: p.date,
        description: p.description,
        amountCents: p.amountCents,
      })),
    ...parts.map((part) => {
      const purchase = byId.get(part.transactionId)!;
      return {
        transactionId: purchase.id,
        closingPeriod: cycleForInstallment(purchase.date, part.sequence, days).closingPeriod,
        date: purchase.date,
        description: `${purchase.description} (parcela ${part.sequence}/${part.installmentCount})`,
        amountCents: part.amountCents,
      };
    }),
  ];
  const charges: Charge[] = items.map(({ closingPeriod, amountCents }) => ({
    closingPeriod,
    amountCents,
  }));
  if (card.openingBalanceCents !== null && card.openingBalanceCents < 0) {
    const closingPeriod = cycleForPurchase(card.openingBalanceDate ?? today, days).closingPeriod;
    const amountCents = -card.openingBalanceCents;
    charges.push({
      closingPeriod,
      amountCents,
    });
    items.push({
      transactionId: null,
      closingPeriod,
      date: card.openingBalanceDate ?? today,
      description: 'Saldo devedor informado',
      amountCents,
    });
  }
  const { invoices, creditCents } = buildInvoices(charges, payments, days, today);
  return { card, invoices, creditCents, items };
}

/** Explica por que o vencimento nao caiu no dia do contrato. */
export function dueShiftNote(invoice: Pick<Invoice, 'dueDate' | 'nominalDueDate'>): string {
  const weekday = weekdayOf(invoice.nominalDueDate);
  const reason = weekday === 0 ? 'cai num domingo' : weekday === 6 ? 'cai num sábado' : 'é feriado';
  return `O vencimento de ${formatShortDate(invoice.nominalDueDate)} ${reason}: passa para ${formatShortDate(invoice.dueDate)}.`;
}

const STATUS_LABEL = {
  paid: 'paga ✅',
  partial: 'paga em parte',
  open: 'em aberto',
} as const;

export function describeStatement(statement: CardStatement, today: LocalDate): string {
  const { card, invoices } = statement;
  const days = cardDays(card)!;
  const lines = [`💳 ${card.name} (fecha dia ${days.closingDay}, vence dia ${days.dueDay})`];

  const closed = invoices.filter((i) => i.status !== 'current' && i.status !== 'future');
  const lastClosed = closed.at(-1);
  const overdue = closed.filter((i) => i.remainingCents > 0 && i.dueDate < today);

  if (lastClosed && lastClosed.totalCents > 0) {
    const status =
      lastClosed.status === 'partial'
        ? `pago ${formatBRL(lastClosed.paidCents)}, falta ${formatBRL(lastClosed.remainingCents)}`
        : STATUS_LABEL[lastClosed.status as keyof typeof STATUS_LABEL];
    lines.push(
      `Fatura de ${monthName(lastClosed.dueDate.slice(0, 7))} (fechou ${formatShortDate(lastClosed.closingDate)}, vence ${formatShortDate(lastClosed.dueDate)}): ${formatBRL(lastClosed.totalCents)} · ${status}`,
    );
  }
  const olderOverdue = overdue.filter((i) => i !== lastClosed);
  if (olderOverdue.length > 0) {
    const total = olderOverdue.reduce((sum, i) => sum + i.remainingCents, 0);
    lines.push(`⚠️ Faturas anteriores ainda em aberto: ${formatBRL(total)}`);
  }
  const current = invoices.find((i) => i.status === 'current');
  if (current) {
    lines.push(
      `Fatura atual (fecha ${formatShortDate(current.closingDate)}, vence ${formatShortDate(current.dueDate)}): ${formatBRL(current.totalCents)} até agora${current.paidCents > 0 ? `, já abatido ${formatBRL(current.paidCents)}` : ''}`,
    );
  }
  const future = invoices.filter((i) => i.status === 'future');
  const futureTotal = future.reduce((sum, i) => sum + i.remainingCents, 0);
  if (futureTotal > 0) {
    lines.push(
      `Parcelas em faturas futuras: ${formatBRL(futureTotal)} (${future.length} fatura(s))`,
    );
  }
  if (statement.creditCents > 0) lines.push(`Crédito a favor: ${formatBRL(statement.creditCents)}`);
  // So para as faturas mostradas acima, sem citar parcelas futuras.
  const shifted = [lastClosed?.remainingCents ? lastClosed : undefined, current].find(
    (i) => i !== undefined && i.dueDate !== i.nominalDueDate,
  );
  if (shifted) lines.push(dueShiftNote(shifted));
  return lines.join('\n');
}

export async function invoicesReport(
  db: Db,
  scope: Scope,
  today: LocalDate,
  cardName: string | null,
): Promise<string> {
  const cards = scope.accounts.filter(
    (a) =>
      a.kind === 'credit_card' &&
      (cardName === null || a.normalizedName.includes(normalizeText(cardName))),
  );
  if (cards.length === 0) {
    return cardName ? `Não achei o cartão "${cardName}".` : 'Nenhum cartão cadastrado.';
  }
  const blocks: string[] = [];
  for (const card of cards) {
    const statement = await cardStatement(db, scope, card, today);
    blocks.push(
      statement
        ? describeStatement(statement, today)
        : `💳 ${card.name}: cadastre os dias para eu montar as faturas, ex.: /editconta ${card.name} fecha=3 vence=10`,
    );
  }
  blocks.push(
    'Pagar a fatura não gera despesa nova: as compras já contaram no dia em que foram feitas.',
  );
  return blocks.join('\n\n');
}
