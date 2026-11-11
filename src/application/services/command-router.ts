import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { canAdminister, canWrite } from '../../domain/household/authorization';
import type { TransactionDraft } from '../../domain/finance/transactions';
import { matchAccount } from '../../domain/finance/transactions';
import { parseMemberPreferences, Tone } from '../../domain/household/settings';
import {
  aiUsage,
  financialTransactions,
  households,
  incomingEvents,
  installmentPlans,
  installments,
} from '../../infrastructure/database/schema';
import { parseMonthExpression, periodOf } from '../../shared/dates';
import { formatBRL, parseBRL } from '../../shared/money';
import { normalizeText } from '../../shared/text';
import { correctTransaction, requestVoid } from '../commands/corrections';
import {
  addAccount,
  addCategory,
  addCommitment,
  findCategoryByText,
  findMember,
  markNextInstallmentPaid,
  setBudget,
  setInstallmentFirstDue,
  setMemberDefaultStatement,
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
import { configureIncome, receiveIncome } from '../commands/income';
import { coupleStatus, myAccountsReport, personalStatus, resolveMember } from '../queries/status';
import type { GoalMovement } from '../commands/goals';
import {
  createGoal,
  editGoal,
  linkGoalAccount,
  moveGoalFunds,
  requestGoalRemoval,
} from '../commands/goals';
import { reportBalance } from '../commands/reconcile';
import { recordDrafts } from '../commands/record-transactions';
import { auditStatement } from '../commands/shared';
import type { Actor, Deps, Effect, Scope } from '../context';
import { replyOnly } from '../context';
import { shortId } from '../queries/finance';
import {
  balancesReport,
  billsReport,
  budgetsReport,
  comparisonReport,
  goalReport,
  singleGoalReport,
  incomeForecastReport,
  monthReport,
  recentReport,
  weekReport,
} from '../queries/reports';
import { analysisAnswer } from './advisor';
import { onboardingCommand } from './onboarding';
import { cardDays, cardStatement, invoicesReport } from '../queries/cards';
import { cycleForInstallment } from '../../domain/finance/card-cycle';
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

/** "@Mercado Pago" chega em dois pedacos: junta quando formam o nome de uma conta. */
function joinAccountTokens(args: readonly string[], accounts: Scope['accounts']): string[] {
  const names = new Set(accounts.map((a) => a.normalizedName));
  const joined: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const prefix = token.startsWith('@') ? 1 : normalizeText(token).startsWith('de:') ? 3 : 0;
    let end = i + 1;
    if (prefix > 0 && token.length > prefix) {
      for (let j = args.length; j > i + 1; j--) {
        const candidate = [token.slice(prefix), ...args.slice(i + 1, j)].join(' ');
        if (names.has(normalizeText(candidate))) {
          end = j;
          break;
        }
      }
    }
    joined.push(args.slice(i, end).join(' '));
    i = end - 1;
  }
  return joined;
}

const NUMERIC_ACCOUNT_OPTIONS = new Set([
  'saldo',
  'fecha',
  'vence',
  'limite',
  'disponivel',
  'divida',
]);
const ACCOUNT_OPTION_COMMANDS = new Set(['addconta', 'editconta']);
const OPTION_VALUE = /^(r\$)?[\d.,]+$|^[?-]$/i;

/** "saldo 1500", "saldo: 1500" e "fecha 3" viram "saldo=1500" e "fecha=3", em vez de parte do nome. */
function inlineAccountOptions(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const match = /^([a-z]+)[:=]?(.*)$/i.exec(token);
    const key = match ? normalizeText(match[1]!) : '';
    if (!NUMERIC_ACCOUNT_OPTIONS.has(key) || /^[a-z]+=.+$/i.test(token)) {
      result.push(token);
      continue;
    }
    let value = match![2]!;
    let next = i;
    if (!value) {
      if (args[next + 1]?.toLowerCase() === 'r$') next++;
      value = args[next + 1] ?? '';
      next++;
    }
    if (OPTION_VALUE.test(value)) {
      result.push(`${key}=${value.replace(/^r\$/i, '')}`);
      i = next;
    } else {
      result.push(token);
    }
  }
  return result;
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
    else if (token.startsWith('@') && token.length > 1)
      account = token.slice(1).replaceAll('_', ' ');
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
  dicas: 'behavioralTips',
} as const;

const WEEKDAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

function notificationsText(settings: Scope['settings']): string {
  const { notifications: n } = settings;
  const state = (on: boolean) => (on ? 'ligado' : 'desligado');
  if (!n.enabled) return 'Notificações desativadas. Para ligar: /notificacoes on';
  return [
    'Notificações:',
    `• contas: ${state(n.billReminders)}, avisa ${settings.billReminderDaysAhead} dias antes`,
    `• orcamento: ${state(n.budgetAlerts)}, em ${settings.budgetAlertThresholds.join('%, ')}%`,
    `• semanal: ${state(n.weeklySummary)}, toda ${WEEKDAY_NAMES[settings.weeklyWeekday]}`,
    `• mensal: ${state(n.monthlyClosing)}, dia 1`,
    `• meta: ${state(n.goalFollowUp)}, a partir do dia ${settings.goalFollowUpDay}`,
    `• dicas: ${state(n.behavioralTips)}, junto com o semanal`,
    'Ligar ou desligar: /notificacoes contas on|off',
    'Ajustar: /notificacoes contas dias=5 · orcamento avisos=70,100 · semanal dia=dom · meta dia=25',
  ].join('\n');
}

type ScheduleChange = { values: Partial<Scope['settings']>; message: string };

function notificationSchedule(
  target: string,
  options: Map<string, string>,
): ScheduleChange | string {
  const usage =
    'Exemplos: /notificacoes contas dias=5 · orcamento avisos=70,100 · semanal dia=dom · meta dia=25';
  if (target === 'contas' && options.has('dias')) {
    const days = Number(options.get('dias'));
    if (!Number.isInteger(days) || days < 0 || days > 15) return 'Use dias de 0 a 15.';
    return {
      values: { billReminderDaysAhead: days },
      message: `Contas: aviso ${days} dias antes.`,
    };
  }
  if (target === 'orcamento' && options.has('avisos')) {
    const values = options.get('avisos')!.split(',').map(Number);
    if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 100)) return 'Use de 1 a 100.';
    const thresholds = [...new Set(values)].sort((a, b) => a - b);
    return {
      values: { budgetAlertThresholds: thresholds },
      message: `Orçamento: avisos em ${thresholds.join('%, ')}%.`,
    };
  }
  if (target === 'semanal' && options.has('dia')) {
    const day = WEEKDAY_NAMES.indexOf(normalizeText(options.get('dia')!).slice(0, 3));
    if (day < 0) return 'Use seg, ter, qua, qui, sex, sab ou dom.';
    return { values: { weeklyWeekday: day }, message: `Semanal: toda ${WEEKDAY_NAMES[day]}.` };
  }
  if (target === 'meta' && options.has('dia')) {
    const day = Number(options.get('dia'));
    if (!Number.isInteger(day) || day < 1 || day > 28) return 'Use um dia de 1 a 28.';
    return {
      values: { goalFollowUpDay: day },
      message: `Metas: acompanhamento a partir do dia ${day}.`,
    };
  }
  return usage;
}

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
  'vincular',
  'saldo',
  'retirada',
  'recorrente',
  'renda',
  'recebi',
  'addconta',
  'addcategoria',
  'contapadrao',
  'cartaopadrao',
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
  rawArgs: string[],
): Promise<Effect> {
  const { scope } = actor;
  const joinedArgs = joinAccountTokens(rawArgs, scope.accounts);
  const args = ACCOUNT_OPTION_COMMANDS.has(command) ? inlineAccountOptions(joinedArgs) : joinedArgs;
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
      if (!canWrite(actor.member)) return replyOnly(await onboardingChecklist(deps, actor));
      return onboardingCommand(deps, actor, rest);
    case 'resumo': {
      const target = rest[0] ? parseMonthExpression(rest.join(' '), actor.today) : period;
      if (!target) return replyOnly('Mês inválido. Use MM/AAAA, ex.: 11/2026.');
      return replyOnly(await monthReport(deps, scope, target));
    }
    case 'semana':
      return replyOnly(await weekReport(deps, scope, actor.today));
    case 'comparar':
      return replyOnly(await comparisonReport(deps, scope, period, actor.today));
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
    case 'meta': {
      const action = normalizeText(rest[0] ?? '');
      if (action === 'criar' || action === 'nova') {
        const name = rest.slice(1).join(' ');
        if (!name)
          return replyOnly(
            'Formato: /meta criar NOME valor=VALOR [prazo=MM/AAAA] [aporte=VALOR] [dono=Nome]',
          );
        return createGoal(deps, actor, {
          name,
          targetText: options.get('valor') ?? null,
          deadlineText: options.get('prazo') ?? null,
          plannedText: options.get('aporte') ?? null,
          ownerText: options.get('dono') ?? null,
          notes: options.get('nota')?.replaceAll('_', ' ') ?? null,
        });
      }
      if (action === 'editar') {
        const name = rest.slice(1).join(' ');
        if (!name)
          return replyOnly(
            'Formato: /meta editar NOME [valor=] [prazo=] [aporte=] [nome=] [nota=]',
          );
        return editGoal(deps, actor, name, {
          name: options.get('nome'),
          target: options.get('valor'),
          deadline: options.get('prazo'),
          planned: options.get('aporte'),
          notes: options.get('nota'),
        });
      }
      if (action === 'remover') {
        if (rest.length < 2) return replyOnly('Formato: /meta remover NOME');
        return requestGoalRemoval(deps, actor, rest.slice(1).join(' '));
      }
      if (rest.length > 0 && options.size > 0 && action !== 'status') {
        return editGoal(deps, actor, rest.join(' '), {
          name: options.get('nome'),
          target: options.get('valor'),
          deadline: options.get('prazo'),
          planned: options.get('aporte'),
          notes: options.get('nota'),
        });
      }
      if (rest.length > 0) {
        const name = action === 'status' ? rest.slice(1).join(' ') : rest.join(' ');
        return replyOnly(await singleGoalReport(deps, scope, actor.today, name));
      }
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
    }
    case 'aporte':
    case 'retirada': {
      const movement = parseGoalMovement(command, args);
      if (typeof movement === 'string') return replyOnly(movement);
      return moveGoalFunds(deps, actor, movement, actor.eventId);
    }
    case 'vincular': {
      // A conta pode ainda nao existir: tudo depois do @ e o nome dela.
      const at = rest.findIndex((t) => t.startsWith('@') && t.length > 1);
      const goalName = rest.slice(0, Math.max(at, 0)).join(' ');
      if (at < 0 || !goalName) return replyOnly('Formato: /vincular META @Conta');
      return linkGoalAccount(deps, actor, goalName, rest.slice(at).join(' ').slice(1));
    }
    case 'saldo': {
      const amount = rest.at(-1);
      if (rest.length < 2 || !amount)
        return replyOnly('Formato: /saldo CONTA VALOR, ex.: /saldo Nubank 830,00');
      return reportBalance(deps, actor, rest.slice(0, -1).join(' '), amount);
    }
    case 'recorrente': {
      const [amountText, ...nameParts] = rest;
      const kind = 'expense' as const;
      if (!amountText || nameParts.length === 0) {
        return replyOnly(
          'Formato: /recorrente 1200 dia=5 aluguel (use ? se o valor variar; util=5 para dia útil). Renda é com /renda.',
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
      if (!amountText) {
        return replyOnly(
          'Formato: /renda 4200 dia=5 @Conta [nome=Freelance] [de=Nome] [irregular]. Use util=5 para dia útil.',
        );
      }
      const irregular = rest.slice(1).some((t) => normalizeText(t) === 'irregular');
      const schedule = irregular
        ? { scheduleType: 'monthly_unspecified' as const, scheduleValue: null }
        : scheduleFromOptions(options);
      if (typeof schedule === 'string') return replyOnly(schedule);
      const accountToken = args.find((t) => t.startsWith('@') && t.length > 1);
      return configureIncome(deps, actor, {
        amountText: amountText === '?' ? null : amountText,
        name: options.get('nome') ?? null,
        ...schedule,
        accountText: accountToken ? accountToken.slice(1) : null,
        personText: options.get('de')?.replaceAll('_', ' ') ?? null,
        irregular,
      });
    }
    case 'recebi': {
      const tokens = rest.filter((t) => !t.startsWith('@'));
      const amountIndex = tokens.findIndex((t) => parseBRL(t).status === 'ok');
      const accountToken = args.find((t) => t.startsWith('@') && t.length > 1);
      return receiveIncome(deps, actor, {
        nameText: tokens.filter((_, i) => i !== amountIndex).join(' ') || null,
        amountText: amountIndex >= 0 ? tokens[amountIndex]! : null,
        accountText: accountToken ? accountToken.slice(1) : null,
        personText: options.get('de')?.replaceAll('_', ' ') ?? null,
        dateText: null,
      });
    }
    case 'statuspessoal':
    case 'minhascontas': {
      const member = resolveMember(actor, rest.join(' ') || null);
      if (typeof member === 'string') return replyOnly(member);
      return replyOnly(
        command === 'statuspessoal'
          ? await personalStatus(deps, actor, member)
          : await myAccountsReport(deps, actor, member),
      );
    }
    case 'statuscasal':
      return replyOnly(await coupleStatus(deps, actor));
    case 'addconta': {
      const kind =
        ACCOUNT_KIND_ALIASES[normalizeText(rest[0] ?? '') as keyof typeof ACCOUNT_KIND_ALIASES];
      const nameParts = rest
        .slice(1)
        .filter((t) => !['padrao', 'alternativa'].includes(normalizeText(t)));
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
        ownerText: options.get('dono')?.replaceAll('_', ' ') ?? null,
        institution: options.get('banco')?.replaceAll('_', ' ') ?? null,
        description: options.get('descricao')?.replaceAll('_', ' ') ?? null,
        sharedFallback: rest.some((t) => normalizeText(t) === 'alternativa'),
        limitText: options.get('limite') ?? null,
        availableText: options.get('disponivel') ?? null,
        debtText: options.get('divida') ?? null,
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
    case 'contapadrao':
      return defaultAccountCommand(deps, actor, 'account', rest, options.get('de') ?? null);
    case 'cartaopadrao':
      return defaultAccountCommand(deps, actor, 'card', rest, options.get('de') ?? null);
    case 'parcela_data':
      if (rest.length < 2) return replyOnly('Formato: /parcela_data CODIGO DD/MM/AAAA');
      return setInstallmentFirstDue(deps, actor, rest[0]!, rest[1]!);
    case 'editconta': {
      const name = rest.filter((t) => normalizeText(t) !== 'padrao').join(' ');
      if (!name) {
        return replyOnly(
          'Formato: /editconta Nome [nome=Novo_Nome] [saldo=VALOR|?] [fecha=N|-] [vence=N|-] [dono=Nome|casal] [banco=Nome] [descricao=Texto] [limite=VALOR] [disponivel=VALOR] [alternativa=sim|nao] [padrao]',
        );
      }
      return editAccount(deps, actor, name, {
        name: options.get('nome'),
        opening: options.get('saldo'),
        closingDay: options.get('fecha'),
        dueDay: options.get('vence'),
        owner: options.get('dono'),
        institution: options.get('banco'),
        description: options.get('descricao'),
        limit: options.get('limite'),
        available: options.get('disponivel'),
        sharedFallback: options.get('alternativa'),
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
      if (rest.length === 0 && options.size === 0) {
        return replyOnly(notificationsText(scope.settings));
      }
      if (options.size > 0) {
        const change = notificationSchedule(normalizeText(rest[0] ?? ''), options);
        if (typeof change === 'string') return replyOnly(change);
        return saveSettings(deps, actor, { ...scope.settings, ...change.values }, change.message);
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
      if (!key) return replyOnly('Tipos: contas, orcamento, semanal, mensal, meta, dicas.');
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

/** Mostra ou define a conta (ou o cartao) padrao de uma pessoa. */
export function defaultAccountCommand(
  deps: Deps,
  actor: Actor,
  type: 'account' | 'card',
  rest: readonly string[],
  personText: string | null,
): Effect {
  const member = personText ? findMember(actor, personText) : actor.member;
  if (!member) return replyOnly(`Não encontrei "${personText}" no cadastro.`);
  const noun = type === 'card' ? 'Cartão padrão' : 'Conta padrão';
  const key = type === 'card' ? 'defaultCardId' : 'defaultAccountId';
  const { scope } = actor;
  if (rest.length === 0) {
    const currentId = parseMemberPreferences(member.preferences)[key];
    const current = scope.accounts.find((a) => a.id === currentId);
    return replyOnly(
      current
        ? `${noun} de ${member.name}: ${current.name}.`
        : `${member.name} ainda não tem ${noun.toLowerCase()}. Exemplo: /${type === 'card' ? 'cartaopadrao' : 'contapadrao'} Nome`,
    );
  }
  const candidates = scope.accounts.filter((a) =>
    type === 'card' ? a.kind === 'credit_card' : a.kind !== 'credit_card' && a.kind !== 'reserve',
  );
  const match = matchAccount(rest.join(' ').replaceAll('_', ' '), candidates, {
    memberId: member.id,
  });
  if (match.status !== 'found') {
    return replyOnly(
      `Não achei com esse nome. Opções: ${candidates.map((a) => a.name).join(', ') || 'nenhuma'}.`,
    );
  }
  const target = match.account;
  if (target.ownership === 'member' && target.ownerMemberId !== member.id) {
    return replyOnly(`${target.name} é de outra pessoa; não pode ser o padrão de ${member.name}.`);
  }
  return {
    statements: [
      setMemberDefaultStatement(deps, member.id, key, target.id),
      auditStatement(deps, actor, 'member.default_updated', 'member', member.id, {
        after: { [key]: target.id },
      }),
    ],
    replies: [{ text: `${noun} de ${member.name}: ${target.name}.` }],
  };
}

/** /aporte [META] VALOR [@Conta] [de:Origem] [data] [existente]. Sem meta, vale o apartamento. */
function parseGoalMovement(command: string, args: readonly string[]): GoalMovement | string {
  const usage = `Formato: /${command} META VALOR [@Conta]${command === 'retirada' ? '' : ' [de:Origem] [existente]'}`;
  const tokens = args.filter((t) => t.toLowerCase() !== 'r$');
  const isMarker = (token: string) =>
    token.startsWith('@') ||
    normalizeText(token).startsWith('de:') ||
    normalizeText(token) === 'existente' ||
    DATE_TOKEN.test(token);
  // O ultimo numero e o valor: o nome da meta pode ter numero ("Viagem 2027").
  let amountIndex = -1;
  tokens.forEach((token, index) => {
    if (!isMarker(token) && parseBRL(token.replace(/^r\$/i, '')).status === 'ok') {
      amountIndex = index;
    }
  });
  if (amountIndex < 0) return usage;
  let accountText: string | null = null;
  let sourceAccountText: string | null = null;
  let dateText: string | null = null;
  let existing = false;
  for (const token of tokens.slice(amountIndex + 1)) {
    if (token.startsWith('@') && token.length > 1) accountText = token.slice(1);
    else if (normalizeText(token).startsWith('de:') && token.length > 3) {
      sourceAccountText = token.slice(3);
    } else if (DATE_TOKEN.test(token)) dateText = token;
    else if (normalizeText(token) === 'existente' && command === 'aporte') existing = true;
    else return usage;
  }
  return {
    goalText: tokens.slice(0, amountIndex).join(' ') || null,
    amountText: tokens[amountIndex]!,
    direction: command === 'retirada' ? 'out' : 'in',
    accountText,
    sourceAccountText,
    dateText,
    kind: existing ? 'allocation' : 'contribution',
    requireLocation: false,
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
      planId: installmentPlans.id,
      transactionId: installmentPlans.transactionId,
      description: financialTransactions.description,
      cardId: financialTransactions.sourceAccountId,
      date: financialTransactions.financialDate,
      total: installmentPlans.totalCents,
      count: installmentPlans.installmentCount,
      firstDue: installmentPlans.firstDueDate,
      sequence: installments.sequence,
      amount: installments.amountCents,
      status: installments.status,
    })
    .from(installmentPlans)
    .innerJoin(financialTransactions, eq(installmentPlans.transactionId, financialTransactions.id))
    .innerJoin(installments, eq(installments.planId, installmentPlans.id))
    .where(
      and(
        eq(installmentPlans.householdId, actor.scope.household.id),
        eq(installmentPlans.status, 'active'),
      ),
    );
  if (rows.length === 0) return 'Nenhum parcelamento ativo.';

  // Em cartao com dias cadastrados, quem define o que foi quitado e o pagamento das faturas.
  const paidCycles = new Map<string, Set<string>>();
  for (const cardId of new Set(rows.map((r) => r.cardId))) {
    const card = actor.scope.accounts.find((a) => a.id === cardId);
    if (!card || !cardDays(card)) continue;
    const statement = await cardStatement(deps.db, actor.scope, card, actor.today);
    if (statement) {
      paidCycles.set(
        card.id,
        new Set(
          statement.invoices.filter((i) => i.remainingCents === 0).map((i) => i.closingPeriod),
        ),
      );
    }
  }

  const lines = [...new Set(rows.map((r) => r.planId))].map((planId) => {
    const parts = rows.filter((r) => r.planId === planId);
    const plan = parts[0]!;
    const card = actor.scope.accounts.find((a) => a.id === plan.cardId);
    const days = card ? cardDays(card) : null;
    const cycles = plan.cardId ? paidCycles.get(plan.cardId) : undefined;
    const isPaid = (part: (typeof parts)[number]) =>
      days && cycles
        ? cycles.has(cycleForInstallment(part.date, part.sequence, days).closingPeriod)
        : part.status === 'paid';
    const paid = parts.filter(isPaid);
    const remaining = parts.filter((p) => !isPaid(p)).reduce((sum, p) => sum + p.amount, 0);
    return `• ${plan.description}: ${formatBRL(plan.total)} em ${plan.count}x, ${paid.length} quitadas, restam ${formatBRL(remaining)} · ${plan.firstDue ? `1º venc. ${plan.firstDue}` : 'sem data de vencimento'} · #${shortId(plan.transactionId)}`;
  });
  return ['Parcelamentos ativos:', ...lines].join('\n');
}
