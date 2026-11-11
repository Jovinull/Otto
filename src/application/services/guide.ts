import { parseMemberPreferences } from '../../domain/household/settings';
import type { HelpTopic } from '../../infrastructure/ai/interpretation';
import { normalizeText } from '../../shared/text';
import type { Account, Actor, Deps } from '../context';
import { loadGoals } from '../queries/finance';
import { commandsText } from './help';

/** Nome pronto para usar depois de @: o Otto aceita o nome como foi cadastrado. */
const at = (account: Account | undefined, fallback: string) => `@${account?.name ?? fallback}`;

interface Profile {
  firstName: string;
  partner: string | null;
  accounts: Account[];
  cards: Account[];
  defaultAccount: Account | undefined;
  defaultCard: Account | undefined;
  reserve: Account | undefined;
}

function profileOf(actor: Actor): Profile {
  const { scope, member } = actor;
  const preferences = parseMemberPreferences(member.preferences);
  const usable = scope.accounts.filter(
    (a) => a.ownerMemberId === member.id || a.ownership === 'shared',
  );
  const accounts = usable.filter((a) => a.kind !== 'credit_card' && a.kind !== 'reserve');
  const cards = usable.filter((a) => a.kind === 'credit_card');
  const partner = scope.members.find((m) => m.id !== member.id && m.status === 'active');
  return {
    firstName: member.name.split(' ')[0]!,
    partner: partner ? partner.name.split(' ')[0]! : null,
    accounts,
    cards,
    defaultAccount:
      scope.accounts.find((a) => a.id === preferences.defaultAccountId) ??
      (accounts.length === 1 ? accounts[0] : undefined),
    defaultCard:
      scope.accounts.find((a) => a.id === preferences.defaultCardId) ??
      (cards.length === 1 ? cards[0] : undefined),
    reserve: usable.find((a) => a.kind === 'reserve' || a.kind === 'savings'),
  };
}

function accountNote(p: Profile): string {
  if (p.accounts.length === 0) {
    return 'Você ainda não tem conta cadastrada: /addconta corrente Nubank saldo 1000 padrao';
  }
  if (!p.defaultAccount) {
    return `Você ainda não tem conta padrão. Defina com /contapadrao ${p.accounts[0]!.name}.`;
  }
  const other = p.accounts.find((a) => a.id !== p.defaultAccount!.id);
  return `Sem dizer a conta, uso a sua padrão (${p.defaultAccount.name}).${other ? ` Outra conta: "pelo ${other.name}" ou ${at(other, '')}.` : ''}`;
}

function cardNote(p: Profile): string {
  if (p.cards.length === 0) {
    return 'Você ainda não tem cartão: /addconta cartao Nome fecha 3 vence 10 padrao';
  }
  if (!p.defaultCard)
    return `Diga qual cartão, ex.: ${at(p.cards[0], 'Cartão')}, ou defina um padrão com /cartaopadrao.`;
  const other = p.cards.find((c) => c.id !== p.defaultCard!.id);
  return `"Cartão" sozinho usa o seu padrão (${p.defaultCard.name}).${other ? ` Outro: ${at(other, '')}.` : ''}`;
}

/** Respostas de "como faço?" montadas com o cadastro real, sem IA. */
export async function howToAnswer(
  deps: Deps,
  actor: Actor,
  topic: HelpTopic | null,
): Promise<string> {
  const p = profileOf(actor);
  const card = p.defaultCard ?? p.cards[0];
  const cardName = card?.name ?? 'Cartão';
  const account = p.defaultAccount ?? p.accounts[0];
  const accountName = account?.name ?? 'Conta';
  switch (topic) {
    case 'expense':
      return [
        'Gasto: escreva normalmente, "Gastei 30 no mercado", ou /gasto 30 mercado.',
        accountNote(p),
        'Outra data: "ontem" ou /gasto 30 mercado 03/11.',
        'Errou? /ultimos mostra o código; /corrigir ou /estornar resolvem.',
      ].join('\n');
    case 'card_purchase':
      return [
        `No cartão: "Comprei 120 no cartão" ou /gasto 120 roupa ${at(card, 'Cartão')}.`,
        'Parcelado: "em 3 vezes" ou /gasto 300 tenis cartao 3x.',
        cardNote(p),
        'A compra conta como gasto no dia. Pagar a fatura depois não conta de novo.',
        '/fatura mostra cada fatura e /parcelas o que falta pagar.',
      ].join('\n');
    case 'income':
      return [
        'Salário caiu: "Meu salário caiu" ou /recebi.',
        'Veio diferente: "Recebi só 2000 do salário" ou /recebi salario 2000.',
        'Entrada avulsa: "Recebi 200 de um freela" ou /receita 200 freela.',
        `Renda que se repete: /renda 4000 dia=5 ${at(account, 'Conta')} (só prevê; o recebimento você avisa).`,
      ].join('\n');
    case 'transfer': {
      const [from, to] = [p.accounts[0], p.accounts[1] ?? p.reserve];
      return [
        `Entre contas: "Transferi 200 do ${from?.name ?? 'Nubank'} pro ${to?.name ?? 'PicPay'}" ou /transferir 200 ${from?.name ?? 'Nubank'} para ${to?.name ?? 'PicPay'}.`,
        'Transferência não é gasto nem receita: o total de vocês não muda.',
        'Para uma meta, use "Guardei 200 para a viagem" (veja /ajuda meta).',
      ].join('\n');
    }
    case 'pay_invoice':
      return [
        `Depois de pagar: "Paguei a fatura do ${cardName}". Eu mostro o valor em aberto e pergunto se foi o total.`,
        `Com valor: /pagar_fatura 300 ${accountName} para ${cardName}.`,
        'Pagamento de fatura não conta como gasto: as compras já contaram no dia.',
        'Antes de pagar, dá para conferir: veja "como confiro a fatura?".',
      ].join('\n');
    case 'check_invoice':
      return [
        `Quando a fatura chegar, me diga o valor: "A fatura do ${cardName} veio 300, confere?" ou /fatura ${cardName} 300.`,
        'Eu comparo com as compras registradas, mostro cada uma com o código e a diferença.',
        `Faltou compra: /gasto VALOR descrição @${cardName} DD/MM. Sobrou: /estornar CODIGO.`,
        `Bateu? Depois de pagar, "Paguei a fatura do ${cardName}".`,
      ].join('\n');
    case 'goal':
    case 'goal_money': {
      const goals = await loadGoals(deps.db, actor.scope.household.id, actor.today);
      const goal = goals[0]?.name ?? 'Viagem';
      const where = p.reserve ? at(p.reserve, '') : at(account, 'Conta');
      const list = goals.length
        ? `Metas de vocês: ${goals.map((g) => g.name).join(', ')}.`
        : 'Vocês ainda não têm metas.';
      return topic === 'goal'
        ? [
            'Criar: /meta criar Viagem valor=8000 prazo=12/2027 (aporte=300 é quanto pretendem guardar por mês).',
            list,
            '/metas mostra o progresso; /meta NOME mostra onde está o dinheiro e quem guardou.',
            `Dinheiro que já estava guardado: /aporte ${goal} 3000 ${where} existente.`,
          ].join('\n')
        : [
            `Guardar: "Guardei 200 para a ${goal.toLowerCase()}" ou /aporte ${goal} 200 ${where}.`,
            `Tirar: "Tirei 100 da ${goal.toLowerCase()}" ou /retirada ${goal} 100 ${where}.`,
            `Saindo de outra conta: /aporte ${goal} 200 ${where} de:${accountName}.`,
            'Guardar não cria dinheiro: ele continua na conta, marcado como reservado.',
            list,
          ].join('\n');
    }
    case 'budget':
      return [
        'Limite por categoria: /orcamento delivery 250. Limite do mês: /orcamento total 3000.',
        '/orcamento mostra como está. Aviso em 80% e em 100%.',
        'Pergunte também: "quanto ainda posso gastar este mês?"',
      ].join('\n');
    case 'fixed_bills':
      return [
        'Conta fixa: /recorrente 1200 dia=5 aluguel. Valor que muda: /recorrente ? dia=10 energia.',
        'Ou escreva: "Nosso aluguel é 1200 e vence todo dia 5".',
        'Quando pagar: "Paguei o aluguel, 1200". /compromissos mostra o que falta no mês.',
      ].join('\n');
    case 'accounts':
      return [
        'Conta: /addconta corrente Nubank saldo 1000 padrao (reserva, poupanca, conjunta e dinheiro também).',
        'Cartão: /addconta cartao Santander fecha 3 vence 10 limite 5000 padrao.',
        'Padrões: /contapadrao Nome e /cartaopadrao Nome. Mudar: /editconta Nome saldo 1200.',
        p.accounts.length || p.cards.length
          ? `Suas: ${[...p.accounts, ...p.cards].map((a) => a.name).join(', ')}. Veja /minhascontas.`
          : 'Você ainda não cadastrou nenhuma.',
      ].join('\n');
    case 'balance_check':
      return [
        `Compare com o banco: "Meu ${accountName} está com 830 agora" ou /saldo ${accountName} 830.`,
        'Eu mostro a diferença e só ajusto se você aprovar.',
        '/contas mostra o saldo, o reservado e o livre de cada conta.',
      ].join('\n');
    case 'correct':
      return [
        '/ultimos mostra os últimos lançamentos com o código (#a1b2c3).',
        'Corrigir: /corrigir a1b2c3 valor 30 · categoria lazer · data 03/11.',
        'Apagar: /estornar a1b2c3 (vale também para aportes). Ou: "apaga o último lançamento".',
      ].join('\n');
    case 'shared':
      return [
        'Gasto dos dois: "Gastamos 80 no mercado" ou /gasto 80 feira casal.',
        p.partner
          ? `Gasto de ${p.partner} lançado por você: /gasto 50 farmacia de:${p.partner}.`
          : 'Gasto de outra pessoa: /gasto 50 farmacia de:Nome.',
        'A conta de outra pessoa nunca é escolhida sozinha: diga qual com @Conta.',
        '/statuscasal mostra os dois sem somar a conta conjunta duas vezes.',
      ].join('\n');
    case 'reports':
      return [
        'Visão geral: /statuspessoal e /statuscasal.',
        'Gastos: /resumo, /semana, /comparar. A pagar e receber: /compromissos.',
        'Cartões: /fatura, /parcelas. Metas: /metas.',
        'Ou pergunte: "quanto ainda posso gastar este mês?", "onde está o dinheiro da viagem?"',
      ].join('\n');
    case 'notifications':
      return [
        '/notificacoes mostra os avisos ligados.',
        'Ajustes: /notificacoes contas dias=5 · semanal dia=dom · meta dia=25 · dicas off.',
      ].join('\n');
    case 'setup':
      return [
        '/configurar faz o cadastro guiado; "pular" pula e /configurar pausar para.',
        '/configurar status mostra o que ainda falta.',
      ].join('\n');
    case 'other':
    case null:
      return [
        'Posso explicar: gastos, cartão, fatura, salário, transferência, metas, orçamento, contas fixas, correções.',
        'Pergunte, por exemplo: "como lanço uma compra parcelada?" ou "como confiro a fatura?".',
        'Lista completa: /comandos.',
      ].join('\n');
  }
}

const TOPIC_WORDS: [HelpTopic, string[]][] = [
  ['check_invoice', ['confer', 'confere', 'bate', 'bateu']],
  ['pay_invoice', ['fatura']],
  ['card_purchase', ['cartao', 'parcel', 'vezes']],
  ['goal_money', ['meta', 'guard', 'cofre', 'reserva', 'viagem', 'apartamento']],
  ['income', ['salario', 'recebi', 'renda', 'caiu']],
  ['transfer', ['transfer', 'pix']],
  ['balance_check', ['saldo']],
  ['correct', ['errad', 'errei', 'corrig', 'apag', 'estorn']],
  ['budget', ['orcamento', 'limite']],
  ['fixed_bills', ['aluguel', 'boleto', 'luz', 'energia', 'internet']],
  ['expense', ['gast', 'compr', 'pague']],
];

const EXAMPLE: Record<HelpTopic, string> = {
  expense: '"Gastei 30 no mercado" ou /gasto 30 mercado',
  card_purchase: '"Comprei 300 no cartão em 3 vezes" ou /gasto 300 tenis cartao 3x',
  income: '"Meu salário caiu" ou /recebi',
  transfer: '"Transferi 200 do Nubank pro PicPay"',
  pay_invoice: '"Paguei a fatura do Nubank" ou /fatura para ver o valor',
  check_invoice: '"A fatura do Nubank veio 300, confere?" ou /fatura Nubank 300',
  goal: '/meta criar Viagem valor=8000',
  goal_money: '"Guardei 200 para a viagem" ou /metas',
  budget: '/orcamento delivery 250 ou /orcamento',
  fixed_bills: '/recorrente 1200 dia=5 aluguel ou /compromissos',
  accounts: '/addconta corrente Nubank saldo 1000 padrao',
  balance_check: '"Meu Nubank está com 830 agora"',
  correct: '/ultimos e depois /corrigir CODIGO valor 30 ou /estornar CODIGO',
  shared: '/gasto 80 feira casal',
  reports: '/statuscasal ou /resumo',
  notifications: '/notificacoes',
  setup: '/configurar',
  other: '/comandos',
};

/** Temas provaveis pelo vocabulario da mensagem, do mais especifico ao mais geral. */
export function topicsFromText(message: string): HelpTopic[] {
  const text = normalizeText(message);
  return TOPIC_WORDS.filter(([, words]) => words.some((w) => text.includes(w))).map(
    ([topic]) => topic,
  );
}

/** Quando nao entende, oferece os caminhos mais provaveis pelo vocabulario da mensagem. */
export function notUnderstood(message: string): string {
  const topics = topicsFromText(message).slice(0, 2);
  const lines = ['Não entendi bem. Nada foi registrado.'];
  if (topics.length > 0) {
    lines.push('Se for isto, é assim:', ...topics.map((t) => `• ${EXAMPLE[t]}`));
  } else {
    lines.push(
      'Exemplos: "Gastei 30 no mercado", "Quanto posso gastar este mês?", "Guardei 200 para a viagem".',
    );
  }
  lines.push('Pode perguntar também: "como faço para ...?"');
  return lines.join('\n');
}

const REMOVED: Record<string, string> = {
  mes: '/resumo MM/AAAA',
  padrao: '/contapadrao',
  faturas: '/fatura',
  conferir: '/fatura CARTÃO VALOR',
  conferir_fatura: '/fatura CARTÃO VALOR',
  configuracoes: '/configurar status',
  individual: '/statuscasal',
  meusaldos: '/minhascontas',
  meuscartoes: '/minhascontas',
  minhasmetas: '/metas',
  rendas: '/compromissos',
  livre: '/contas',
  alocar: '/aporte META VALOR @Conta existente',
  desfazer_aporte: '/estornar CODIGO',
  saldos: '/contas',
  gastos: '/resumo',
  despesa: '/gasto',
  meta_criar: '/meta criar',
};

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

let known: string[] | null = null;

/** Comando inexistente: aponta o substituto ou o comando de nome parecido. */
export function unknownCommand(command: string): string {
  const name = normalizeText(command);
  if (REMOVED[name]) return `Use ${REMOVED[name]}. Lista completa: /comandos.`;
  known ??= [
    ...new Set([...commandsText().matchAll(/\/([a-z_]+)/g)].map((m) => m[1]!)),
    'ajuda',
    'comandos',
  ];
  const ranked = known
    .map((k) => ({ k, d: distance(name, k) }))
    .filter(({ k, d }) => d <= (k.length <= 4 ? 1 : 2) || (name.length >= 3 && k.startsWith(name)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map(({ k }) => `/${k}`);
  return ranked.length > 0
    ? `Não conheço /${command}. Você quis dizer ${ranked.join(' ou ')}?`
    : 'Não conheço esse comando. /comandos lista todos, e /ajuda tem exemplos.';
}
