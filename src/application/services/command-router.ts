import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { canAdminister, canWrite } from '../../domain/household/authorization';
import type { TransactionDraft } from '../../domain/finance/transactions';
import { parseMemberPreferences, Tone } from '../../domain/household/settings';
import {
  aiUsage,
  financialTransactions,
  householdMembers,
  households,
  incomingEvents,
  installmentPlans,
  installments,
} from '../../infrastructure/database/schema';
import { parseMonthExpression, periodOf } from '../../shared/dates';
import { formatBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import { correctTransaction, requestVoid } from '../commands/corrections';
import {
  addAccount,
  addCategory,
  addCommitment,
  addGoalContribution,
  findCategoryByText,
  markNextInstallmentPaid,
  requestContributionVoid,
  setBudget,
  setInstallmentFirstDue,
  updateApartmentGoal,
} from '../commands/planning';
import {
  editAccount,
  editCategory,
  editRecurring,
  removeBudget,
  removeRecurring,
  requestArchiveAccount,
} from '../commands/editing';
import { recordDrafts } from '../commands/record-transactions';
import { auditStatement } from '../commands/shared';
import type { Actor, Deps, Effect } from '../context';
import { replyOnly } from '../context';
import { shortId } from '../queries/finance';
import {
  balancesReport,
  billsReport,
  budgetsReport,
  comparisonReport,
  goalReport,
  incomeForecastReport,
  monthReport,
  peopleReport,
  recentReport,
  weekReport,
} from '../queries/reports';
import { analysisAnswer } from './advisor';
import { invoicesReport } from '../queries/cards';
import { aiSpend } from './ai-governor';
import { commandsText, helpText, onboardingChecklist } from './help';

interface ParsedOptions {
  options: Map<string, string>;
  rest: string[];
}

function splitOptions(args: readonly string[]): ParsedOptions {
  const options = new Map<string, string>();
  const rest: string[] = [];
  for (const arg of args) {
    const match = /^([a-z_]+)=(.+)$/i.exec(arg);
    if (match) options.set(normalizeText(match[1]!), match[2]!);
    else rest.push(arg);
  }
  return { options, rest };
}

const DATE_TOKEN = /^(hoje|ontem|anteontem|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/i;

function buildDraftFromArgs(
  kind: 'expense' | 'income',
  args: readonly string[],
): TransactionDraft | string {
  const tokens = [...args];
  if (tokens[0]?.toLowerCase() === 'r$') tokens.shift();
  const amountText = tokens.shift();
  if (!amountText) {
    return kind === 'expense'
      ? 'Faltou o valor. Exemplo: /gasto 25,50 mercado'
      : 'Faltou o valor. Exemplo: /receita 4200 salario';
  }
  let category: string | null = null;
  let account: string | null = null;
  let dateText: string | null = null;
  let installmentsCount: number | null = null;
  let isCredit = false;
  let shared = false;
  let person: string | null = null;
  const description: string[] = [];
  for (const token of tokens) {
    const lower = normalizeText(token);
    if (token.startsWith('#') && token.length > 1) category = normalizeText(token.slice(1));
    else if (token.startsWith('@') && token.length > 1) account = token.slice(1);
    else if (DATE_TOKEN.test(token)) dateText = token;
    else if (/^\d{1,2}x$/i.test(token)) installmentsCount = Number(token.slice(0, -1));
    else if (lower === 'cartao') isCredit = true;
    else if (lower === 'casal') shared = true;
    else if (lower.startsWith('de:') && lower.length > 3) person = token.slice(3);
    else description.push(token);
  }
  if (description.length === 0) return 'Faltou a descrição. Exemplo: /gasto 25,50 mercado';
  return {
    kind,
    amountText,
    description: description.join(' ').slice(0, 120),
    categorySlug: category,
    personText: person,
    isShared: shared,
    sourceAccountText: kind === 'expense' ? account : null,
    destinationAccountText: kind === 'income' ? account : null,
    dateText,
    paymentMethod: isCredit ? 'credit' : 'unknown',
    installments: installmentsCount,
  };
}

function transferDraft(
  args: readonly string[],
  kind: 'transfer' | 'card_payment',
): TransactionDraft | string {
  const usage =
    kind === 'transfer'
      ? 'Formato: /transferir 500 nubank para reserva'
      : 'Formato: /pagar_fatura 850 nubank para cartao';
  const amountText = args[0];
  if (!amountText) return usage;
  const joined = args.slice(1).join(' ');
  const [source, destination] = joined.split(/\s+(?:para|>)\s+/i);
  if (!source?.trim() || !destination?.trim()) return usage;
  return {
    kind,
    amountText,
    description: kind === 'transfer' ? 'Transferência entre contas' : 'Pagamento de fatura',
    categorySlug: null,
    personText: null,
    isShared: false,
    sourceAccountText: source.trim(),
    destinationAccountText: destination.trim(),
    dateText: null,
    paymentMethod: 'unknown',
    installments: null,
  };
}

const ACCOUNT_KIND_ALIASES = {
  corrente: 'checking',
  poupanca: 'savings',
  dinheiro: 'cash',
  reserva: 'reserve',
  conjunta: 'joint',
  cartao: 'credit_card',
} as const;

const NOTIFICATION_KEYS = {
  contas: 'billReminders',
  orcamento: 'budgetAlerts',
  semanal: 'weeklySummary',
  mensal: 'monthlyClosing',
  meta: 'goalFollowUp',
} as const;

function toneLabel(tone: Tone): string {
  return { neutral: 'neutro', friendly: 'amigável', firm: 'firme' }[tone];
}

const WRITE_COMMANDS = new Set([
  'gasto',
  'receita',
  'transferir',
  'pagar_fatura',
  'corrigir',
  'estornar',
  'orcamento',
  'meta',
  'aporte',
  'retirada',
  'desfazer_aporte',
  'recorrente',
  'renda',
  'addconta',
  'addcategoria',
  'padrao',
  'parcela_data',
  'parcela_paga',
  'editconta',
  'removerconta',
  'editcategoria',
  'editrecorrente',
  'removerrecorrente',
  'removerorcamento',
]);

const ADMIN_COMMANDS = new Set(['tom', 'notificacoes']);

/** Comandos deterministicos: funcionam sem IA e sem custo. */
export async function handleCommand(
  deps: Deps,
  actor: Actor,
  command: string,
  args: string[],
): Promise<Effect> {
  const { scope } = actor;
  const period = periodOf(actor.today);
  const { options, rest } = splitOptions(args);

  const isQueryOnlyBudget = command === 'orcamento' && args.length === 0;
  if (WRITE_COMMANDS.has(command) && !isQueryOnlyBudget && !canWrite(actor.member)) {
    return replyOnly('Seu perfil é somente leitura: não posso alterar dados por este comando.');
  }
  if (ADMIN_COMMANDS.has(command) && args.length > 0 && !canAdminister(actor.member)) {
    return replyOnly('Só administradores podem mudar essa configuração.');
  }

  switch (command) {
    case 'ajuda':
    case 'start':
    case 'help':
      return replyOnly(helpText(rest[0] ?? null));
    case 'comandos':
      return replyOnly(commandsText());
    case 'id':
      return replyOnly(`Chat ID: ${actor.chatId}\nSeu user ID: ${actor.member.telegramUserId}`);
    case 'status':
      return replyOnly(await statusText(deps, actor));
    case 'configurar':
    case 'configuracoes':
      return replyOnly(await onboardingChecklist(deps, actor));
    case 'resumo':
    case 'mes': {
      const target = rest[0] ? parseMonthExpression(rest.join(' '), actor.today) : period;
      if (!target) return replyOnly('Mês inválido. Use MM/AAAA, ex.: 11/2026.');
      return replyOnly(await monthReport(deps, scope, target));
    }
    case 'semana':
      return replyOnly(await weekReport(deps, scope, actor.today));
    case 'comparar':
      return replyOnly(await comparisonReport(deps, scope, period, actor.today));
    case 'individual':
      return replyOnly(await peopleReport(deps, scope, period));
    case 'contas':
      return replyOnly(await balancesReport(deps, scope));
    case 'compromissos':
      return replyOnly(
        `${await billsReport(deps, scope, period)}\n\n${await incomeForecastReport(deps, scope, period)}`,
      );
    case 'ultimos': {
      const limit = Math.min(Number(rest[0]) || 10, 20);
      return replyOnly(await recentReport(deps, scope, limit));
    }
    case 'categorias':
      return replyOnly(
        scope.categories
          .filter((c) => c.kind === 'expense')
          .map((c) => `• ${c.name} (${c.slug})`)
          .join('\n'),
      );
    case 'metas':
      return replyOnly(await goalReport(deps, scope, actor.today));
    case 'fatura':
    case 'faturas':
      return replyOnly(
        await invoicesReport(deps.db, scope, actor.today, rest.length ? rest.join(' ') : null),
      );
    case 'parcelas':
      return replyOnly(await installmentsReport(deps, actor));
    case 'ia':
      return replyOnly(await aiUsageReport(deps));
    case 'analise':
      return replyOnly(
        await analysisAnswer(
          deps,
          scope,
          actor.member.id,
          actor.today,
          rest.join(' ') || 'Como estamos neste mês?',
        ),
      );

    case 'gasto':
    case 'receita': {
      const kind = command === 'gasto' ? 'expense' : 'income';
      const draft = buildDraftFromArgs(kind, args);
      if (typeof draft === 'string') return replyOnly(draft);
      return recordDrafts(deps, actor, [draft], {
        origin: 'command',
        idempotencyPrefix: actor.eventId,
      });
    }
    case 'transferir':
    case 'pagar_fatura': {
      const draft = transferDraft(args, command === 'transferir' ? 'transfer' : 'card_payment');
      if (typeof draft === 'string') return replyOnly(draft);
      return recordDrafts(deps, actor, [draft], {
        origin: 'command',
        idempotencyPrefix: actor.eventId,
      });
    }
    case 'corrigir': {
      const [reference, field, ...value] = rest;
      const map = { valor: 'amount', categoria: 'category', data: 'date' } as const;
      const target = field ? map[normalizeText(field) as keyof typeof map] : undefined;
      if (!reference || !target || value.length === 0) {
        return replyOnly(
          'Formato: /corrigir CODIGO valor|categoria|data NOVO. Ex.: /corrigir a1b2c3 valor 30,00',
        );
      }
      return correctTransaction(deps, actor, reference, target, value.join(' '), false);
    }
    case 'estornar': {
      if (!rest[0]) return replyOnly('Formato: /estornar CODIGO (veja /ultimos).');
      return requestVoid(deps, actor, rest[0]);
    }
    case 'orcamento': {
      if (rest.length === 0) return replyOnly(await budgetsReport(deps, scope, actor.today));
      if (rest.length === 1) {
        const category = findCategoryByText(actor, rest[0]!, 'expense');
        if (!category) return replyOnly('Categoria não encontrada. Veja /categorias.');
        return replyOnly(await budgetsReport(deps, scope, actor.today, category.id));
      }
      const amount = rest[rest.length - 1]!;
      const name = rest.slice(0, -1).join(' ');
      return setBudget(
        deps,
        actor,
        normalizeText(name) === 'total' ? null : name,
        amount,
        options.get('de') ?? null,
      );
    }
    case 'meta':
      if (options.size === 0) return replyOnly(await goalReport(deps, scope, actor.today));
      return updateApartmentGoal(deps, actor, {
        entry: options.get('entrada') ?? null,
        additionalCosts: options.get('custos') ?? null,
        deadline: options.get('prazo') ?? null,
        plannedMonthly: options.get('aporte') ?? null,
        emergencyReserve: options.get('reserva') ?? null,
        initialConfirmed: options.get('inicial') ?? null,
        notes: options.get('nota') ?? null,
      });
    case 'aporte':
    case 'retirada': {
      if (!rest[0]) return replyOnly(`Formato: /${command} 500`);
      return addGoalContribution(
        deps,
        actor,
        rest[0],
        command === 'aporte' ? 'in' : 'out',
        rest[1] ?? null,
        actor.eventId,
      );
    }
    case 'desfazer_aporte':
      if (!rest[0]) return replyOnly('Formato: /desfazer_aporte CODIGO');
      return requestContributionVoid(deps, actor, rest[0]);
    case 'recorrente': {
      const [kindText, amountText, ...nameParts] = rest;
      const kind =
        normalizeText(kindText ?? '') === 'despesa'
          ? 'expense'
          : normalizeText(kindText ?? '') === 'receita'
            ? 'income'
            : null;
      if (!kind || !amountText || nameParts.length === 0) {
        return replyOnly(
          'Formato: /recorrente despesa 1200 dia=5 aluguel (use ? se o valor variar; util=5 para dia útil).',
        );
      }
      const schedule = scheduleFromOptions(options);
      if (typeof schedule === 'string') return replyOnly(schedule);
      return addCommitment(deps, actor, {
        kind,
        description: nameParts.join(' '),
        amountText: amountText === '?' ? null : amountText,
        ...schedule,
        personText: options.get('de') ?? null,
        categoryText: options.get('categoria') ?? null,
      });
    }
    case 'renda': {
      const amountText = rest[0];
      if (!amountText) return replyOnly('Formato: /renda 4200 dia=5 ou /renda 4200 util=5');
      const schedule = scheduleFromOptions(options);
      if (typeof schedule === 'string') return replyOnly(schedule);
      return addCommitment(deps, actor, {
        kind: 'income',
        description: 'Salário',
        amountText,
        ...schedule,
        personText: actor.member.name,
        categoryText: 'salario',
      });
    }
    case 'addconta': {
      const kind =
        ACCOUNT_KIND_ALIASES[normalizeText(rest[0] ?? '') as keyof typeof ACCOUNT_KIND_ALIASES];
      const nameParts = rest.slice(1).filter((t) => normalizeText(t) !== 'padrao');
      if (!kind || nameParts.length === 0) {
        return replyOnly(
          'Formato: /addconta corrente|poupanca|dinheiro|reserva|conjunta|cartao Nome [saldo=1200] [padrao] [fecha=3] [vence=10] [dono=Nome]',
        );
      }
      return addAccount(deps, actor, {
        kind,
        name: nameParts.join(' '),
        openingText: options.get('saldo') ?? null,
        isDefault: rest.some((t) => normalizeText(t) === 'padrao'),
        closingDay: options.has('fecha') ? Number(options.get('fecha')) : null,
        dueDay: options.has('vence') ? Number(options.get('vence')) : null,
        ownerText: options.get('dono') ?? null,
      });
    }
    case 'addcategoria': {
      const natureMap = {
        essencial: 'essential',
        discricionaria: 'discretionary',
        outra: 'other',
      } as const;
      const nature = natureMap[normalizeText(rest.at(-1) ?? '') as keyof typeof natureMap];
      if (!nature || rest.length < 2) {
        return replyOnly('Formato: /addcategoria Nome essencial|discricionaria|outra');
      }
      return addCategory(deps, actor, rest.slice(0, -1).join(' '), nature);
    }
    case 'padrao': {
      if (rest.length === 0) return replyOnly('Formato: /padrao NomeDaConta');
      const target = scope.accounts.find((a) => a.normalizedName === normalizeText(rest.join(' ')));
      if (!target || target.kind === 'credit_card') return replyOnly('Conta não encontrada.');
      const preferences = {
        ...parseMemberPreferences(actor.member.preferences),
        defaultAccountId: target.id,
      };
      return {
        statements: [
          deps.db
            .update(householdMembers)
            .set({ preferences: JSON.stringify(preferences) })
            .where(eq(householdMembers.id, actor.member.id)),
        ],
        replies: [{ text: `Conta padrão de ${actor.member.name}: ${target.name}.` }],
      };
    }
    case 'parcela_data':
      if (rest.length < 2) return replyOnly('Formato: /parcela_data CODIGO DD/MM/AAAA');
      return setInstallmentFirstDue(deps, actor, rest[0]!, rest[1]!);
    case 'editconta': {
      const name = rest.filter((t) => normalizeText(t) !== 'padrao').join(' ');
      if (!name) {
        return replyOnly(
          'Formato: /editconta Nome [nome=Novo_Nome] [saldo=VALOR|?] [fecha=N|-] [vence=N|-] [dono=Nome|casal] [padrao]',
        );
      }
      return editAccount(deps, actor, name, {
        name: options.get('nome'),
        opening: options.get('saldo'),
        closingDay: options.get('fecha'),
        dueDay: options.get('vence'),
        owner: options.get('dono'),
        makeDefault: rest.some((t) => normalizeText(t) === 'padrao'),
      });
    }
    case 'removerconta':
      if (rest.length === 0) return replyOnly('Formato: /removerconta Nome');
      return requestArchiveAccount(deps, actor, rest.join(' '));
    case 'editcategoria':
      if (rest.length === 0) {
        return replyOnly(
          'Formato: /editcategoria codigo [nome=Novo_Nome] [tipo=essencial|discricionaria|outra]',
        );
      }
      return editCategory(deps, actor, rest.join(' '), {
        name: options.get('nome'),
        nature: options.get('tipo'),
      });
    case 'editrecorrente':
      if (rest.length === 0) {
        return replyOnly('Formato: /editrecorrente nome [valor=VALOR|?] [dia=N] [util=N]');
      }
      return editRecurring(deps, actor, rest.join(' '), {
        amount: options.get('valor'),
        day: options.get('dia'),
        businessDay: options.get('util'),
      });
    case 'removerrecorrente':
      if (rest.length === 0) return replyOnly('Formato: /removerrecorrente nome');
      return removeRecurring(deps, actor, rest.join(' '));
    case 'removerorcamento':
      if (rest.length === 0)
        return replyOnly('Formato: /removerorcamento categoria|total [de=Nome]');
      return removeBudget(deps, actor, rest.join(' '), options.get('de') ?? null);
    case 'parcela_paga':
      if (!rest[0]) return replyOnly('Formato: /parcela_paga CODIGO');
      return markNextInstallmentPaid(deps, actor, rest[0]);
    case 'tom': {
      if (rest.length === 0)
        return replyOnly(
          `Tom atual: ${toneLabel(scope.settings.tone)}. Opções: neutro, amigavel, firme.`,
        );
      const map = { neutro: 'neutral', amigavel: 'friendly', firme: 'firm' } as const;
      const tone = map[normalizeText(rest[0]!) as keyof typeof map];
      if (!tone) return replyOnly('Opções: neutro, amigavel, firme.');
      return saveSettings(
        deps,
        actor,
        { ...scope.settings, tone },
        `Tom ajustado: ${toneLabel(tone)}.`,
      );
    }
    case 'notificacoes': {
      const { notifications } = scope.settings;
      if (rest.length === 0) {
        return replyOnly(
          `Notificações ${notifications.enabled ? 'ativas' : 'desativadas'}. Ajuste: /notificacoes on|off ou /notificacoes contas|orcamento|semanal|mensal|meta on|off`,
        );
      }
      const flag = normalizeText(rest.at(-1)!);
      if (flag !== 'on' && flag !== 'off') return replyOnly('Use on ou off.');
      const value = flag === 'on';
      if (rest.length === 1) {
        return saveSettings(
          deps,
          actor,
          { ...scope.settings, notifications: { ...notifications, enabled: value } },
          `Notificações ${value ? 'ativadas' : 'desativadas'}.`,
        );
      }
      const key = NOTIFICATION_KEYS[normalizeText(rest[0]!) as keyof typeof NOTIFICATION_KEYS];
      if (!key) return replyOnly('Tipos: contas, orcamento, semanal, mensal, meta.');
      return saveSettings(
        deps,
        actor,
        { ...scope.settings, notifications: { ...notifications, [key]: value } },
        `Notificação ${normalizeText(rest[0]!)}: ${value ? 'ativada' : 'desativada'}.`,
      );
    }
    default:
      return replyOnly('Não conheço esse comando. Veja /ajuda.');
  }
}

function saveSettings(
  deps: Deps,
  actor: Actor,
  settings: Actor['scope']['settings'],
  message: string,
): Effect {
  const id = actor.scope.household.id;
  return {
    statements: [
      deps.db
        .update(households)
        .set({ settings: JSON.stringify(settings) })
        .where(eq(households.id, id)),
      auditStatement(deps, actor, 'settings.updated', 'household', id, {}),
    ],
    replies: [{ text: message }],
  };
}

function scheduleFromOptions(options: Map<string, string>):
  | {
      scheduleType: 'monthly_day' | 'nth_weekday_approx' | 'monthly_unspecified';
      scheduleValue: number | null;
    }
  | string {
  if (options.has('dia')) {
    const day = Number(options.get('dia'));
    if (!Number.isInteger(day)) return 'Dia inválido. Exemplo: dia=5';
    return { scheduleType: 'monthly_day', scheduleValue: day };
  }
  if (options.has('util')) {
    const n = Number(options.get('util'));
    if (!Number.isInteger(n)) return 'Valor inválido. Exemplo: util=5';
    return { scheduleType: 'nth_weekday_approx', scheduleValue: n };
  }
  return { scheduleType: 'monthly_unspecified', scheduleValue: null };
}

async function statusText(deps: Deps, actor: Actor): Promise<string> {
  const [rows] = await deps.db.batch([
    deps.db
      .select({
        status: incomingEvents.status,
        count: sql<number>`count(*)`,
      })
      .from(incomingEvents)
      .groupBy(incomingEvents.status),
  ]);
  const queue = rows
    .filter((r) => ['received', 'retry', 'deferred', 'failed'].includes(r.status))
    .map((r) => `${r.status}: ${r.count}`)
    .join(', ');
  const [count] = await deps.db
    .select({ count: sql<number>`count(*)` })
    .from(financialTransactions)
    .where(eq(financialTransactions.householdId, actor.scope.household.id));
  return [
    `Otto ativo (${deps.config.environment}).`,
    `IA: ${deps.ai ? 'configurada' : 'não configurada'}`,
    `Fila: ${queue || 'vazia'}`,
    `Lançamentos: ${count?.count ?? 0}`,
    `Fuso: ${actor.scope.household.timezone}`,
  ].join('\n');
}

async function aiUsageReport(deps: Deps): Promise<string> {
  const spend = await aiSpend(deps);
  const usd = (micro: number) => `US$ ${(micro / 1_000_000).toFixed(4)}`;
  const since = new Date(deps.now());
  const monthStart = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1);
  const rows = await deps.db
    .select({
      model: aiUsage.model,
      operation: aiUsage.operation,
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`sum(${aiUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${aiUsage.outputTokens})`,
      cost: sql<number>`sum(${aiUsage.estimatedCostMicroUsd})`,
    })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, monthStart))
    .groupBy(aiUsage.model, aiUsage.operation)
    .orderBy(desc(sql`sum(${aiUsage.estimatedCostMicroUsd})`));
  return [
    `Uso de IA (estimativa local):`,
    `Hoje: ${usd(spend.dayMicroUsd)} de ${usd(deps.config.dailyBudgetMicroUsd)}`,
    `Mês: ${usd(spend.monthMicroUsd)} de ${usd(deps.config.monthlyBudgetMicroUsd)}`,
    ...rows.map((r) => `• ${r.model} (${r.operation}): ${r.calls} chamadas, ${usd(r.cost)}`),
  ].join('\n');
}

async function installmentsReport(deps: Deps, actor: Actor): Promise<string> {
  const rows = await deps.db
    .select({
      transactionId: installmentPlans.transactionId,
      description: financialTransactions.description,
      total: installmentPlans.totalCents,
      count: installmentPlans.installmentCount,
      firstDue: installmentPlans.firstDueDate,
      remaining: sql<number>`sum(case when ${installments.status} = 'scheduled' then ${installments.amountCents} else 0 end)`,
      paid: sql<number>`sum(case when ${installments.status} = 'paid' then 1 else 0 end)`,
    })
    .from(installmentPlans)
    .innerJoin(financialTransactions, eq(installmentPlans.transactionId, financialTransactions.id))
    .innerJoin(installments, eq(installments.planId, installmentPlans.id))
    .where(
      and(
        eq(installmentPlans.householdId, actor.scope.household.id),
        eq(installmentPlans.status, 'active'),
      ),
    )
    .groupBy(installmentPlans.id);
  if (rows.length === 0) return 'Nenhum parcelamento ativo.';
  return [
    'Parcelamentos ativos:',
    ...rows.map(
      (r) =>
        `• ${r.description}: ${formatBRL(r.total)} em ${r.count}x, ${r.paid} quitadas, restam ${formatBRL(r.remaining)} · ${r.firstDue ? `1º venc. ${r.firstDue}` : 'sem data de vencimento'} · #${shortId(r.transactionId)}`,
    ),
  ].join('\n');
}
