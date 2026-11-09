import type { TransactionDraft } from '../../domain/finance/transactions';
import { amountAppearsInText, matchAccount } from '../../domain/finance/transactions';
import { canWrite } from '../../domain/household/authorization';
import type { Interpretation, TransactionItem } from '../../infrastructure/ai/interpretation';
import type { Stmt } from '../../infrastructure/database/client';
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
  addAccount,
  addCommitment,
  findCategoryByText,
  setBudget,
  updateApartmentGoal,
} from '../commands/planning';
import {
  createGoal,
  isApartmentName,
  linkedGoalOf,
  linkGoalAccount,
  moveGoalFunds,
} from '../commands/goals';
import { reportBalance } from '../commands/reconcile';
import { invoicesReport } from '../queries/cards';
import { accountFreeReport, coupleStatus, personalStatus, resolveMember } from '../queries/status';
import { defaultAccountCommand } from './command-router';
import { recordDrafts } from '../commands/record-transactions';
import type { Actor, Deps, Effect } from '../context';
import { replyOnly } from '../context';
import {
  balancesReport,
  billsReport,
  budgetsReport,
  cashFlowAnswer,
  goalReport,
  singleGoalReport,
  incomeForecastReport,
  spendingAnswer,
  topExpensesReport,
} from '../queries/reports';
import { analysisAnswer, consultPurchase } from './advisor';
import { confirmLatest } from './pending';

function toDraft(item: TransactionItem): TransactionDraft {
  // Quem fala em numero de parcelas, mesmo "1 vez", esta falando de credito.
  const paymentMethod =
    item.installments !== null && item.payment_method === 'unknown'
      ? 'credit'
      : item.payment_method;
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
    paymentMethod,
    installments: item.installments,
  };
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** O modelo as vezes toma o nome do assistente, em "Otto, ...", como a pessoa citada. */
function withoutAssistantName(interpretation: Interpretation): Interpretation {
  const person = <T extends string | null>(value: T): T | null =>
    value !== null && normalizeText(value) === 'otto' ? null : value;
  const { query, budget, commitment, account, transactions } = interpretation;
  return {
    ...interpretation,
    transactions: transactions.map((t) => ({ ...t, person_text: person(t.person_text) })),
    query: query && { ...query, person_text: person(query.person_text) },
    budget: budget && { ...budget, person_text: person(budget.person_text) },
    commitment: commitment && { ...commitment, person_text: person(commitment.person_text) },
    account: account && { ...account, owner_text: person(account.owner_text) },
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

/** Transferir para um cofre ligado a uma unica meta e guardar para ela. */
async function transferToLinkedVault(
  deps: Deps,
  actor: Actor,
  interpretation: Interpretation,
  message: string,
): Promise<Effect | null> {
  const [transfer, ...others] = interpretation.transactions;
  if (
    !transfer ||
    others.length > 0 ||
    transfer.kind !== 'transfer' ||
    transfer.amount_text === null ||
    interpretation.confidence === 'low' ||
    !amountAppearsInText(transfer.amount_text, message) ||
    !transfer.source_account_text ||
    !transfer.destination_account_text
  ) {
    return null;
  }
  const accounts = actor.scope.accounts.filter((a) => a.kind !== 'credit_card');
  const match = matchAccount(transfer.destination_account_text, accounts, {
    memberId: actor.member.id,
  });
  if (match.status !== 'found') return null;
  const goal = await linkedGoalOf(deps, actor, match.account.id);
  if (!goal) return null;
  return moveGoalFunds(
    deps,
    actor,
    {
      goalText: goal.name,
      amountText: transfer.amount_text,
      direction: 'in',
      accountText: match.account.name,
      sourceAccountText: transfer.source_account_text,
      dateText: transfer.date_text,
      kind: 'contribution',
      requireLocation: false,
    },
    actor.eventId,
  );
}

/**
 * Executa uma interpretacao. A saida do modelo e dado nao confiavel: cada caminho passa pelas
 * regras do dominio e so existe o que estiver neste switch.
 */
export async function routeIntent(
  deps: Deps,
  actor: Actor,
  received: Interpretation,
  message: string,
  addressed: boolean,
): Promise<Effect> {
  const interpretation = withoutAssistantName(received);
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
      const vault = await transferToLinkedVault(deps, actor, interpretation, message);
      if (vault) return vault;
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
      return moveGoalFunds(
        deps,
        actor,
        {
          goalText: interpretation.goal?.goal_name ?? null,
          amountText: amount,
          direction: 'in',
          accountText: interpretation.goal?.account_text ?? null,
          sourceAccountText: interpretation.goal?.source_account_text ?? null,
          dateText: interpretation.goal?.contribution_date_text ?? null,
          kind: 'contribution',
          requireLocation: true,
        },
        actor.eventId,
      );
    }

    case 'register_commitment': {
      if (!write) return replyOnly(READ_ONLY);
      const commitment = interpretation.commitment;
      if (!commitment) return replyOnly('Não entendi o compromisso. Veja /ajuda recorrentes.');
      if (
        commitment.due_day === null &&
        commitment.nth_business_day === null &&
        !commitment.is_monthly
      ) {
        // Sem dia, pode ser valor avulso ("a luz veio 187"): nao vira previsao mensal sozinho.
        const value = commitment.amount_text ?? 'VALOR';
        return replyOnly(
          `Isso se repete todo mês? Se sim, me diga o dia: ${commitment.kind === 'income' ? `/renda ${value} dia=10 nome=${commitment.description.replaceAll(' ', '_')}` : `/recorrente ${value} dia=10 ${commitment.description}`}. Se é só desta vez, eu registro quando for ${commitment.kind === 'income' ? 'recebido' : 'pago'}.`,
        );
      }
      if (
        commitment.amount_text !== null &&
        !amountAppearsInText(commitment.amount_text, message)
      ) {
        return replyOnly('Não consegui confirmar o valor. Use /recorrente 1200 dia=5 aluguel.');
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
      let accountId: string | null = null;
      if (commitment.account_text) {
        const accounts = scope.accounts.filter((a) => a.kind !== 'credit_card');
        const owner =
          findMemberId(actor, commitment.person_text) === 'unknown'
            ? actor.member.id
            : ((findMemberId(actor, commitment.person_text) as string | undefined) ??
              actor.member.id);
        const match = matchAccount(commitment.account_text, accounts, { memberId: owner });
        if (match.status !== 'found') {
          return replyOnly(
            `Não achei a conta "${commitment.account_text}". Cadastre com /addconta ou repita com o nome certo.`,
          );
        }
        accountId = match.account.id;
      }
      return addCommitment(deps, actor, {
        accountId,
        kind: commitment.kind,
        description: capitalized(commitment.description),
        amountText: commitment.amount_text,
        ...schedule,
        personText: commitment.person_text,
        categoryText: commitment.category_slug,
      });
    }

    case 'query_balance':
      return replyOnly(
        interpretation.query?.account_text
          ? await accountFreeReport(deps, actor, interpretation.query.account_text)
          : await balancesReport(deps, scope),
      );

    case 'query_spending': {
      const { range, label } = period(interpretation.query, today);
      const memberId = findMemberId(actor, interpretation.query?.person_text ?? null);
      if (memberId === 'unknown') return replyOnly('Não encontrei essa pessoa no cadastro.');
      const categorySlug = interpretation.query?.category_slug;
      const category = categorySlug ? findCategoryByText(actor, categorySlug, 'expense') : null;
      const accountText = interpretation.query?.account_text;
      let spendingAccount: { id: string; name: string } | undefined;
      if (accountText) {
        const match = matchAccount(accountText, scope.accounts, {
          memberId: memberId ?? actor.member.id,
        });
        if (match.status === 'ambiguous') {
          return replyOnly(`Qual delas? ${match.options.map((a) => a.name).join(', ')}.`);
        }
        if (match.status !== 'found') return replyOnly(`Não achei "${accountText}". Veja /contas.`);
        spendingAccount = match.account;
      }
      return replyOnly(
        await spendingAnswer(deps, scope, {
          range,
          label,
          categoryId: category?.id,
          categoryName: category?.name,
          memberId,
          accountId: spendingAccount?.id,
          accountName: spendingAccount?.name,
        }),
      );
    }

    case 'query_budget': {
      const slug = interpretation.query?.category_slug ?? interpretation.budget?.category_slug;
      const category = slug ? findCategoryByText(actor, slug, 'expense') : null;
      return replyOnly(await budgetsReport(deps, scope, today, category?.id));
    }

    case 'query_goal':
      return replyOnly(
        interpretation.goal?.goal_name
          ? await singleGoalReport(deps, scope, today, interpretation.goal.goal_name)
          : await goalReport(deps, scope, today),
      );

    case 'query_status_personal': {
      const member = resolveMember(actor, interpretation.query?.person_text ?? null);
      return replyOnly(
        typeof member === 'string' ? member : await personalStatus(deps, actor, member),
      );
    }

    case 'query_status_couple':
      return replyOnly(await coupleStatus(deps, actor));

    case 'query_invoices':
      return replyOnly(
        await invoicesReport(deps.db, scope, today, interpretation.query?.account_text ?? null),
      );

    case 'query_free_balance': {
      const accountText = interpretation.query?.account_text;
      return replyOnly(
        accountText
          ? await accountFreeReport(deps, actor, accountText)
          : await personalStatus(deps, actor, actor.member),
      );
    }

    case 'create_account': {
      if (!write) return replyOnly(READ_ONLY);
      const account = interpretation.account;
      const nameText = account?.name_text ?? (account?.kind === 'joint' ? 'Conta conjunta' : null);
      if (!account || !nameText) {
        return replyOnly('Qual o nome da conta? Exemplo: /addconta corrente Nubank saldo=1000');
      }
      if (account.opening_text !== null && !amountAppearsInText(account.opening_text, message)) {
        return replyOnly(
          'Não consegui confirmar o valor. Use /addconta corrente Nome saldo=VALOR.',
        );
      }
      // "Jennifer tem PicPay e Nubank" sao duas contas. Com saldo, o valor seria de qual?
      const names =
        account.opening_text === null
          ? nameText.split(/\s+e\s+|\s*,\s*/i).filter(Boolean)
          : [nameText];
      const statements: Stmt[] = [];
      const replies: string[] = [];
      for (const name of names) {
        const effect = await addAccount(deps, actor, {
          kind:
            account.kind ?? (/cofre|caixinha/.test(normalizeText(name)) ? 'reserve' : 'checking'),
          name,
          openingText: account.opening_text,
          isDefault: account.role === 'primary',
          closingDay: account.closing_day,
          dueDay: account.due_day,
          ownerText: account.owner_text,
        });
        statements.push(...effect.statements);
        replies.push(...effect.replies.map((r) => r.text));
      }
      return { statements, replies: [{ text: replies.join('\n') }] };
    }

    case 'set_default_account':
    case 'set_default_card': {
      if (!write) return replyOnly(READ_ONLY);
      const name = interpretation.account?.name_text;
      if (!name) return replyOnly('Qual conta? Exemplo: /contapadrao Nubank');
      return defaultAccountCommand(
        deps,
        actor,
        interpretation.intent === 'set_default_card' ? 'card' : 'account',
        [name],
        interpretation.account?.owner_text ?? null,
      );
    }

    case 'create_goal': {
      if (!write) return replyOnly(READ_ONLY);
      const goal = interpretation.goal;
      if (!goal?.goal_name) return replyOnly('Qual o nome da meta? /meta criar NOME valor=VALOR');
      const amounts = [goal.target_text, goal.planned_monthly_text].filter(
        (value): value is string => value !== null,
      );
      if (amounts.some((value) => !amountAppearsInText(value, message))) {
        return replyOnly('Não consegui confirmar os valores. Use /meta criar NOME valor=VALOR.');
      }
      if (isApartmentName(goal.goal_name)) {
        return updateApartmentGoal(deps, actor, {
          entry: goal.target_text,
          additionalCosts: null,
          deadline: goal.deadline_text,
          plannedMonthly: goal.planned_monthly_text,
          emergencyReserve: null,
          initialConfirmed: null,
        });
      }
      return createGoal(deps, actor, {
        name: capitalized(goal.goal_name),
        targetText: goal.target_text,
        deadlineText: goal.deadline_text,
        plannedText: goal.planned_monthly_text,
      });
    }

    case 'allocate_goal':
    case 'withdraw_goal': {
      if (!write) return replyOnly(READ_ONLY);
      const goal = interpretation.goal;
      const withdrawing = interpretation.intent === 'withdraw_goal';
      if (!goal?.contribution_text) {
        if (!withdrawing && goal?.account_text) {
          return linkGoalAccount(deps, actor, goal.goal_name, goal.account_text);
        }
        return replyOnly('Qual o valor? Exemplo: /retirada Viagem 200 @Conta');
      }
      if (!amountAppearsInText(goal.contribution_text, message)) {
        return replyOnly('Não consegui confirmar o valor. Use /aporte ou /retirada.');
      }
      return moveGoalFunds(
        deps,
        actor,
        {
          goalText: goal.goal_name,
          amountText: goal.contribution_text,
          direction: withdrawing ? 'out' : 'in',
          accountText: goal.account_text,
          sourceAccountText: null,
          dateText: goal.contribution_date_text,
          kind: withdrawing ? 'contribution' : 'allocation',
          requireLocation: !withdrawing,
        },
        actor.eventId,
      );
    }

    case 'report_balance': {
      if (!write) return replyOnly(READ_ONLY);
      const account = interpretation.account;
      if (!account?.name_text || account.opening_text === null) {
        return replyOnly('Qual conta e valor? Exemplo: /saldo Nubank 830,00');
      }
      if (!amountAppearsInText(account.opening_text, message)) {
        return replyOnly('Não consegui confirmar o valor. Use /saldo CONTA VALOR.');
      }
      return reportBalance(deps, actor, account.name_text, account.opening_text);
    }

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
