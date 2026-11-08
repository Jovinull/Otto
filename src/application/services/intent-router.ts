import type { TransactionDraft } from '../../domain/finance/transactions';
import { amountAppearsInText } from '../../domain/finance/transactions';
import { canWrite } from '../../domain/household/authorization';
import type { Interpretation, TransactionItem } from '../../infrastructure/ai/interpretation';
import {
  monthRange,
  NAMED_PERIOD_LABEL,
  parseMonthExpression,
  periodOf,
  resolveNamedPeriod,
  type DateRange,
  monthName,
} from '../../shared/dates';
import { parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import { correctTransaction, requestVoid } from '../commands/corrections';
import {
  addCommitment,
  addGoalContribution,
  findCategoryByText,
  setBudget,
  updateApartmentGoal,
} from '../commands/planning';
import { recordDrafts } from '../commands/record-transactions';
import type { Actor, Deps, Effect } from '../context';
import { replyOnly } from '../context';
import {
  balancesReport,
  billsReport,
  budgetsReport,
  cashFlowAnswer,
  goalReport,
  incomeForecastReport,
  spendingAnswer,
  topExpensesReport,
} from '../queries/reports';
import { analysisAnswer, consultPurchase } from './advisor';
import { confirmLatest } from './pending';

function toDraft(item: TransactionItem): TransactionDraft {
  return {
    kind: item.kind,
    amountText: item.amount_text,
    description: item.description.trim() || 'Sem descrição',
    categorySlug: item.category_slug,
    personText: item.person_text,
    isShared: item.is_shared,
    sourceAccountText: item.source_account_text,
    destinationAccountText: item.destination_account_text,
    dateText: item.date_text,
    paymentMethod: item.payment_method,
    installments: item.installments,
  };
}

const READ_ONLY = 'Seu perfil é somente leitura: posso consultar, mas não alterar dados.';

function period(
  query: Interpretation['query'],
  today: string,
): { range: DateRange; label: string } {
  if (query?.month_text) {
    const target = parseMonthExpression(query.month_text, today);
    if (target) return { range: monthRange(target), label: `em ${monthName(target)}` };
  }
  const named = query?.period ?? 'this_month';
  return { range: resolveNamedPeriod(named, today), label: NAMED_PERIOD_LABEL[named] };
}

function targetPeriod(query: Interpretation['query'], today: string): string {
  if (query?.month_text) {
    const target = parseMonthExpression(query.month_text, today);
    if (target) return target;
  }
  return periodOf(today);
}

function findMemberId(actor: Actor, personText: string | null): string | undefined | 'unknown' {
  if (!personText) return undefined;
  const text = normalizeText(personText);
  if (['eu', 'mim'].includes(text)) return actor.member.id;
  const first = text.split(' ')[0];
  const member = actor.scope.members.find((m) => normalizeText(m.name).split(' ')[0] === first);
  return member?.id ?? 'unknown';
}

/** Valor citado por extenso ou confianca baixa nao viram lancamento sem o usuario confirmar. */
function confirmationNeeded(
  interpretation: Interpretation,
  drafts: readonly TransactionDraft[],
  message: string,
): string | null {
  if (interpretation.confidence === 'low') return 'Fiquei em dúvida se entendi certo:';
  const unverified = drafts.some(
    (draft) => draft.amountText !== null && !amountAppearsInText(draft.amountText, message),
  );
  return unverified ? 'Quero conferir o valor antes de anotar:' : null;
}

/**
 * Executa uma interpretacao. A saida do modelo e dado nao confiavel: cada caminho passa pelas
 * regras do dominio e so existe o que estiver neste switch.
 */
export async function routeIntent(
  deps: Deps,
  actor: Actor,
  interpretation: Interpretation,
  message: string,
  addressed: boolean,
): Promise<Effect> {
  const { scope, today } = actor;
  const write = canWrite(actor.member);

  switch (interpretation.intent) {
    case 'register_expense':
    case 'register_income':
    case 'register_transfer': {
      if (!write) return replyOnly(READ_ONLY);
      if (interpretation.transactions.length === 0) {
        return addressed
          ? replyOnly('Não identifiquei nenhum lançamento nessa mensagem.')
          : { statements: [], replies: [] };
      }
      const drafts = interpretation.transactions.map(toDraft);
      return recordDrafts(deps, actor, drafts, {
        origin: 'natural_language',
        idempotencyPrefix: actor.eventId,
        confirmationReason: confirmationNeeded(interpretation, drafts, message),
      });
    }

    case 'register_goal_contribution': {
      if (!write) return replyOnly(READ_ONLY);
      const amount = interpretation.goal?.contribution_text ?? null;
      if (!amount) return replyOnly('Qual foi o valor guardado? Exemplo: /aporte 500');
      if (!amountAppearsInText(amount, message)) {
        return replyOnly('Não consegui confirmar o valor na mensagem. Use /aporte 500, por favor.');
      }
      return addGoalContribution(deps, actor, amount, 'in', null, actor.eventId);
    }

    case 'register_commitment': {
      if (!write) return replyOnly(READ_ONLY);
      const commitment = interpretation.commitment;
      if (!commitment) return replyOnly('Não entendi o compromisso. Veja /ajuda recorrentes.');
      if (
        commitment.amount_text !== null &&
        !amountAppearsInText(commitment.amount_text, message)
      ) {
        return replyOnly(
          'Não consegui confirmar o valor. Use /recorrente despesa 1200 dia=5 aluguel.',
        );
      }
      const schedule =
        commitment.due_day !== null
          ? ({ scheduleType: 'monthly_day', scheduleValue: commitment.due_day } as const)
          : commitment.nth_business_day !== null
            ? ({
                scheduleType: 'nth_weekday_approx',
                scheduleValue: commitment.nth_business_day,
              } as const)
            : ({ scheduleType: 'monthly_unspecified', scheduleValue: null } as const);
      return addCommitment(deps, actor, {
        kind: commitment.kind,
        description: commitment.description,
        amountText: commitment.amount_text,
        ...schedule,
        personText: commitment.person_text,
        categoryText: commitment.category_slug,
      });
    }

    case 'query_balance':
      return replyOnly(await balancesReport(deps, scope));

    case 'query_spending': {
      const { range, label } = period(interpretation.query, today);
      const memberId = findMemberId(actor, interpretation.query?.person_text ?? null);
      if (memberId === 'unknown') return replyOnly('Não encontrei essa pessoa no cadastro.');
      const categorySlug = interpretation.query?.category_slug;
      const category = categorySlug ? findCategoryByText(actor, categorySlug, 'expense') : null;
      return replyOnly(
        await spendingAnswer(deps, scope, {
          range,
          label,
          categoryId: category?.id,
          categoryName: category?.name,
          memberId,
        }),
      );
    }

    case 'query_budget': {
      const slug = interpretation.query?.category_slug ?? interpretation.budget?.category_slug;
      const category = slug ? findCategoryByText(actor, slug, 'expense') : null;
      return replyOnly(await budgetsReport(deps, scope, today, category?.id));
    }

    case 'query_goal':
      return replyOnly(await goalReport(deps, scope, today));

    case 'query_bills':
      return replyOnly(await billsReport(deps, scope, targetPeriod(interpretation.query, today)));

    case 'query_income_forecast':
      return replyOnly(
        await incomeForecastReport(deps, scope, targetPeriod(interpretation.query, today)),
      );

    case 'query_cashflow': {
      const { range, label } = period(interpretation.query, today);
      return replyOnly(await cashFlowAnswer(deps, scope, range, label));
    }

    case 'query_top_expenses': {
      const { range, label } = period(interpretation.query, today);
      return replyOnly(await topExpensesReport(deps, scope, range, label));
    }

    case 'set_budget': {
      if (!write) return replyOnly(READ_ONLY);
      const budget = interpretation.budget;
      if (!budget?.amount_text) return replyOnly('Qual o limite? Exemplo: /orcamento delivery 250');
      if (!amountAppearsInText(budget.amount_text, message)) {
        return replyOnly('Não consegui confirmar o valor. Use /orcamento delivery 250.');
      }
      return setBudget(deps, actor, budget.category_slug, budget.amount_text, budget.person_text);
    }

    case 'set_goal': {
      if (!write) return replyOnly(READ_ONLY);
      const goal = interpretation.goal;
      if (!goal) return replyOnly('Não entendi a meta. Veja /ajuda meta.');
      const values = [
        goal.entry_text,
        goal.additional_costs_text,
        goal.planned_monthly_text,
        goal.emergency_reserve_text,
        goal.initial_confirmed_text,
      ].filter((value): value is string => value !== null);
      if (values.some((value) => !amountAppearsInText(value, message))) {
        return replyOnly(
          'Não consegui confirmar os valores. Use /meta entrada=VALOR prazo=MM/AAAA.',
        );
      }
      return updateApartmentGoal(deps, actor, {
        entry: goal.entry_text,
        additionalCosts: goal.additional_costs_text,
        deadline: goal.deadline_text,
        plannedMonthly: goal.planned_monthly_text,
        emergencyReserve: goal.emergency_reserve_text,
        initialConfirmed: goal.initial_confirmed_text,
      });
    }

    case 'correct_transaction': {
      if (!write) return replyOnly(READ_ONLY);
      const correction = interpretation.correction;
      if (!correction) return replyOnly('Veja o código em /ultimos e use /corrigir.');
      if (correction.field === 'void') return requestVoid(deps, actor, correction.transaction_ref);
      if (!correction.value_text)
        return replyOnly('Qual é o novo valor? Exemplo: /corrigir a1b2c3 valor 30,00');
      return correctTransaction(
        deps,
        actor,
        correction.transaction_ref,
        correction.field,
        correction.value_text,
        true,
      );
    }

    case 'confirm_action':
    case 'cancel_action':
      if (!write) return replyOnly(READ_ONLY);
      return confirmLatest(deps, actor, interpretation.intent === 'confirm_action');

    case 'consult_purchase': {
      const purchase = interpretation.purchase;
      const parsed = purchase?.amount_text ? parseBRL(purchase.amount_text) : null;
      if (!purchase || parsed?.status !== 'ok') {
        return replyOnly('Qual o valor do gasto que vocês estão pensando?');
      }
      return replyOnly(
        await consultPurchase(deps, scope, today, {
          amountCents: parsed.cents,
          description: purchase.description,
          category: purchase.category_slug
            ? findCategoryByText(actor, purchase.category_slug, 'expense')
            : null,
        }),
      );
    }

    case 'request_analysis':
      return replyOnly(await analysisAnswer(deps, scope, actor.member.id, today, message));

    case 'unknown':
      return addressed
        ? replyOnly('Não entendi. Pode reformular? Se preferir, /ajuda lista os comandos.')
        : { statements: [], replies: [] };

    case 'not_financial':
      return { statements: [], replies: [] };
  }
}
