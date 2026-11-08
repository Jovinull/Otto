import { periodOf } from '../../shared/dates';
import type { Actor, Deps } from '../context';
import { loadBudgetViews, loadCommitments, loadGoals } from '../queries/finance';

const MAIN_HELP = `Oi! Sou o Otto, o companheiro financeiro de vocês. É só escrever normalmente:
"Gastei 27 reais com Uber", "Quanto gastamos este mês?", "Podemos pedir uma pizza de 90?"

Sem IA (sempre funciona):
/gasto 25,50 mercado · /receita 4200 salario
/transferir 500 nubank para reserva
/resumo · /mes 10/2026 · /semana · /comparar · /individual
/orcamento · /metas · /contas · /compromissos · /parcelas
/ultimos · /corrigir · /estornar
/configurar mostra o que falta cadastrar.
/comandos lista todos os comandos.

Mais detalhes: /ajuda gastos, /ajuda contas, /ajuda orcamento, /ajuda meta, /ajuda recorrentes, /ajuda opcoes`;

const TOPICS: Record<string, string> = {
  gastos: `Lançamentos
/gasto VALOR descrição [#categoria] [@conta] [ontem|03/11] [cartao] [6x] [casal] [de:Nome]
/receita VALOR descrição [#categoria] [@conta] [ontem|03/11]
Exemplos: /gasto 80 mercado de:Jennifer · /gasto 1200 celular cartao 6x
Corrigir: /corrigir a1b2c3 valor 30,00 · categoria lazer · data 03/11
Estornar: /estornar a1b2c3 (pede confirmação)`,
  contas: `Contas
/addconta corrente|poupanca|dinheiro|reserva|conjunta|cartao Nome [saldo=1200,50] [padrao] [fecha=3] [vence=10] [dono=Nome]
/padrao Nome define sua conta padrão
/transferir 500 origem para destino · /pagar_fatura 850 origem para cartao
Sem saldo inicial eu mostro só o que foi movimentado aqui, nunca um saldo real.
Limitação atual: mostro a dívida total do cartão, não a fatura separada por ciclo.`,
  orcamento: `Orçamento mensal
/orcamento delivery 250 · /orcamento total 3000 · /orcamento lazer 150 de=Jennifer
/orcamento consulta · /orcamento delivery consulta uma categoria
Avisos em 80%, 100% e ao ultrapassar, uma vez por mês.`,
  meta: `Meta do apartamento
/meta entrada=80000 custos=10000 prazo=12/2027 aporte=1500 reserva=5000 inicial=3000
"aporte" é intenção. Só conta como guardado o que entrar por inicial= ou /aporte 500.
/retirada 200 · /desfazer_aporte CODIGO · /metas consulta o progresso`,
  recorrentes: `Compromissos e renda prevista
/recorrente despesa 1200 dia=5 aluguel
/recorrente despesa ? dia=10 energia (valor variável)
/renda 4200 util=5
util=5 é aproximado: não considero feriados.
Nada é marcado como pago sozinho: avise com "paguei o aluguel, 1200".`,
  opcoes: `Preferências
/tom neutro|amigavel|firme
/notificacoes on|off · /notificacoes contas|orcamento|semanal|mensal|meta on|off
/categorias · /addcategoria Nome essencial|discricionaria|outra
/ia mostra o consumo estimado · /status mostra a saúde do sistema`,
};

const COMMANDS_TEXT = `Todos os comandos (funcionam sem IA):

Lançamentos
/gasto VALOR descrição — registra despesa
/receita VALOR descrição — registra receita
/transferir VALOR origem para destino — move entre contas
/pagar_fatura VALOR conta para cartão — paga fatura
/corrigir CÓDIGO valor|categoria|data NOVO — corrige lançamento
/estornar CÓDIGO — anula lançamento (pede confirmação)
/parcela_data CÓDIGO DD/MM/AAAA — 1º vencimento do parcelamento
/parcela_paga CÓDIGO — quita a próxima parcela

Consultas
/resumo ou /mes [MM/AAAA] — resumo do mês
/semana — semana atual
/comparar — mês atual vs anterior
/individual — gastos por pessoa
/contas — saldos conhecidos e cartões
/compromissos — contas a pagar e renda prevista
/orcamento [categoria] — situação dos orçamentos
/metas — meta do apartamento
/parcelas — parcelamentos ativos
/ultimos [N] — últimos lançamentos com código
/categorias — categorias e códigos
/analise [pergunta] — análise do mês

Cadastro
/addconta tipo Nome [saldo=] [padrao] [fecha=] [vence=] — cria conta ou cartão
/padrao Conta — sua conta padrão
/addcategoria Nome essencial|discricionaria|outra — cria categoria
/orcamento categoria VALOR [de=Nome] — define limite mensal
/meta entrada= custos= prazo=MM/AAAA aporte= reserva= inicial= — configura a meta
/aporte VALOR · /retirada VALOR · /desfazer_aporte CÓDIGO — dinheiro da meta
/recorrente despesa|receita VALOR dia=N|util=N nome — conta ou receita fixa
/renda VALOR dia=N|util=N — sua renda prevista

Sistema
/configurar — o que falta cadastrar
/tom neutro|amigavel|firme — estilo das respostas (admin)
/notificacoes on|off — avisos automáticos (admin)
/ia — consumo de IA · /status — saúde do Otto · /id — seus IDs
/ajuda TEMA — exemplos detalhados`;

export function commandsText(): string {
  return COMMANDS_TEXT;
}

export function helpText(topic: string | null): string {
  if (!topic) return MAIN_HELP;
  return TOPICS[topic.toLowerCase()] ?? MAIN_HELP;
}

/** Cadastro incremental: mostra o que ja existe e o que falta, sem exigir nada. */
export async function onboardingChecklist(deps: Deps, actor: Actor): Promise<string> {
  const { scope } = actor;
  const period = periodOf(actor.today);
  const [commitments, budgets, goals] = await Promise.all([
    loadCommitments(deps.db, scope.household.id, period),
    loadBudgetViews(deps.db, scope, period),
    loadGoals(deps.db, scope.household.id, actor.today),
  ]);
  const incomes = commitments.filter((c) => c.kind === 'income');
  const bills = commitments.filter((c) => c.kind === 'expense');
  const goal = goals.find((g) => g.kind === 'apartment');
  const members = scope.members.filter((m) => m.status === 'active');
  const withoutIncome = members.filter((m) => !incomes.some((i) => i.memberId === m.id));

  const mark = (done: boolean) => (done ? '✅' : '⬜');
  const items = [
    `${mark(scope.accounts.length > 0)} Contas (${scope.accounts.length}) — /addconta corrente Nubank saldo=1000 padrao`,
    `${mark(withoutIncome.length === 0)} Renda prevista${withoutIncome.length ? ` (falta: ${withoutIncome.map((m) => m.name).join(', ')})` : ''} — cada um manda /renda 4200 util=5`,
    `${mark(bills.length > 0)} Contas fixas (${bills.length}) — "Nosso aluguel é 1200 e vence todo dia 5"`,
    `${mark(budgets.length > 0)} Orçamentos (${budgets.length}) — /orcamento delivery 250`,
    `${mark(goal?.progress.targetCents !== null && goal !== undefined)} Meta do apartamento — /meta entrada=VALOR custos=VALOR prazo=MM/AAAA`,
    `${mark(goal?.progress.plannedMonthlyCents !== null && goal !== undefined)} Aporte mensal pretendido — /meta aporte=VALOR`,
    `${mark(goal !== undefined && goal.emergencyReserveCents !== null)} Reserva de emergência (separada) — /meta reserva=VALOR`,
  ];
  return [
    'O que já sei e o que falta (no ritmo de vocês, dá para lançar gastos desde já):',
    ...items,
  ].join('\n');
}
