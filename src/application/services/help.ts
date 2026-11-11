import { periodOf } from '../../shared/dates';
import { parseMemberPreferences } from '../../domain/household/settings';
import type { Actor, Deps } from '../context';
import { loadBudgetViews, loadCommitments, loadGoals } from '../queries/finance';

const MAIN_HELP = `Oi! Sou o Otto, o companheiro financeiro de vocês. É só escrever normalmente:
"Gastei 27 reais com Uber", "Paguei a fatura do Santander", "Quanto gastamos este mês?", "Podemos pedir uma pizza de 90?"

Sem IA (sempre funciona):
/gasto 25,50 mercado · /receita 900 bonus
/transferir 500 nubank para reserva
/statuspessoal · /statuscasal · /resumo · /semana · /comparar
/contas · /minhascontas · /fatura · /parcelas
/orcamento · /metas · /compromissos · /ultimos
/corrigir · /estornar
/configurar faz o cadastro guiado; /configurar status mostra o que falta.
/comandos lista todos os comandos.

Dúvida? Pergunte: "Otto, como confiro a fatura?"
Mais detalhes: /ajuda gastos, /ajuda contas, /ajuda editar, /ajuda orcamento, /ajuda meta, /ajuda recorrentes, /ajuda opcoes`;

const TOPICS: Record<string, string> = {
  gastos: `Lançamentos
/gasto VALOR descrição [#categoria] [@conta] [ontem|03/11] [cartao] [6x] [casal] [de:Nome]
/receita VALOR descrição [#categoria] [@conta] [ontem|03/11]
Exemplos: /gasto 80 mercado de:Nome · /gasto 1200 celular cartao 6x @Mercado Pago
Corrigir: /corrigir a1b2c3 valor 30,00 · categoria lazer · data 03/11
Estornar: /estornar a1b2c3 (pede confirmação; vale também para aportes)`,
  contas: `Contas e cartões
/addconta corrente|poupanca|dinheiro|reserva|conjunta|cartao Nome [saldo=1200,50] [padrao] [fecha=3] [vence=10] [limite=5000] [dono=Nome]
/contapadrao Nome · /cartaopadrao Nome: seus padrões (cada pessoa tem o seu)
/transferir 500 origem para destino · /pagar_fatura 850 origem para cartão
/saldo Nubank 830: compara com o saldo real e só ajusta se você aprovar
/minhascontas: suas contas e cartões · /contas: todas
A conta de outra pessoa nunca é escolhida sozinha.
Sem saldo inicial eu mostro só o que foi movimentado aqui, nunca um saldo real.
/fatura mostra cada fatura quando o cartão tem fecha= e vence=.
/fatura Nubank 300 confere o valor que veio do banco com as compras registradas.
Vencimento em fim de semana ou feriado passa para o próximo dia útil.
Juros e multas: lance como gasto no cartão, ex.: /gasto 12,90 juros @Nubank.`,
  editar: `Editar cadastros
/editconta Nubank fecha=3 vence=10 · /editconta Nubank saldo=1500 (saldo=? apaga)
/editconta Nubank nome=Nubank_Pessoal dono=Nome padrao (use _ no lugar de espaço em valores com =)
/removerconta Nubank (arquiva; histórico continua)
/editcategoria lazer nome=Passeios tipo=discricionaria
/editrecorrente aluguel valor=1300 dia=10 · /editrecorrente salario util=5
/removerrecorrente netflix · /removerorcamento delivery
Lançamentos: /corrigir e /estornar.`,
  orcamento: `Orçamento mensal
/orcamento delivery 250 · /orcamento total 3000 · /orcamento lazer 150 de=Nome
/orcamento consulta · /orcamento delivery consulta uma categoria
Avisos em 80%, 100% e ao ultrapassar, uma vez por mês.`,
  meta: `Metas
/meta criar Viagem valor=8000 [prazo=12/2027] [aporte=500] [dono=Nome]
/metas · /meta Viagem · /meta Viagem valor=9000 · /meta remover Viagem
/aporte Viagem 500 @Cofre de:Nubank: transfere de verdade e reserva
/aporte Viagem 500 @Nubank: dinheiro novo que já está lá
/aporte Viagem 3000 @Nubank existente: dinheiro antigo, não conta como aporte do mês
/retirada Viagem 200 @Nubank · /vincular Viagem @Cofre · /estornar CODIGO
Reservar não cria dinheiro: R$ 3.000 em contas continuam R$ 3.000 no patrimônio.
Apartamento: /meta entrada=80000 custos=10000 prazo=12/2027 aporte=1500 reserva=5000 inicial=3000
"aporte=" é intenção. Só conta como guardado o que entrar por inicial= ou /aporte.`,
  recorrentes: `Contas fixas e renda
/recorrente 1200 dia=5 aluguel · /recorrente ? dia=10 energia (valor variável)
/renda 4200 util=5 @Nubank [nome=Freelance] [de=Nome] [irregular]
/recebi [nome] [valor]: marca a renda como recebida
/compromissos mostra o que falta pagar e receber no mês
util=5 considera fins de semana e feriados nacionais; feriados locais não.
Nada é marcado como pago sozinho: avise com "paguei o aluguel, 1200".`,
  opcoes: `Preferências
/tom neutro|amigavel|firme
/notificacoes mostra e explica os avisos
/notificacoes on|off · /notificacoes contas|orcamento|semanal|mensal|meta|dicas on|off
/notificacoes contas dias=5 · orcamento avisos=70,100 · semanal dia=dom · meta dia=25
/categorias · /addcategoria Nome essencial|discricionaria|outra
/ia mostra o consumo estimado · /status mostra a saúde do sistema`,
};

const COMMANDS_TEXT = `Todos os comandos (funcionam sem IA):

Lançamentos
/gasto VALOR descrição — despesa
/receita VALOR descrição — receita avulsa
/transferir VALOR origem para destino — entre contas
/pagar_fatura VALOR conta para cartão — paga fatura
/corrigir CÓDIGO valor|categoria|data NOVO
/estornar CÓDIGO — anula lançamento ou aporte
/parcela_data CÓDIGO DD/MM/AAAA · /parcela_paga CÓDIGO — só parcelas sem cartão com dias

Consultas
/statuspessoal [Nome] · /statuscasal — visão geral
/resumo [MM/AAAA] · /semana · /comparar
/contas — todas · /minhascontas [Nome] — as suas
/compromissos — contas a pagar e renda do mês
/orcamento [categoria] · /metas · /meta NOME
/fatura [cartão] [valor] — faturas; com valor, confere · /parcelas
/ultimos [N] · /categorias · /analise [pergunta]

Cadastro
/addconta tipo Nome [saldo=] [padrao] [fecha=] [vence=] [limite=] [dono=]
/contapadrao Conta · /cartaopadrao Cartão
/saldo Conta VALOR — compara com o saldo real
/renda VALOR dia=N|util=N [@Conta] [nome=] [de=] [irregular]
/recebi [nome] [valor] — renda recebida
/recorrente VALOR dia=N|util=N nome — conta fixa
/orcamento categoria VALOR [de=Nome]
/addcategoria Nome essencial|discricionaria|outra

Metas
/meta criar NOME valor= [prazo=] [aporte=] [dono=]
/meta NOME valor= prazo= aporte= nome= · /meta remover NOME
/meta entrada= custos= prazo= aporte= reserva= inicial= — apartamento
/aporte [META] VALOR [@Conta] [de:Origem] [existente]
/retirada [META] VALOR [@Conta]
/vincular META @Conta — onde a meta fica

Editar e remover
/editconta Nome nome= saldo= fecha= vence= dono= limite= padrao
/removerconta Nome
/editcategoria codigo nome= tipo=
/editrecorrente nome valor= dia= util=
/removerrecorrente nome · /removerorcamento categoria|total

Sistema
/configurar [status|pausar|renda|contas|fixas|orcamento|apartamento|alertas]
/tom neutro|amigavel|firme · /notificacoes
/ia · /status · /id · /ajuda TEMA`;

export function commandsText(): string {
  return COMMANDS_TEXT;
}

export function hasHelpTopic(topic: string): boolean {
  return topic.toLowerCase() in TOPICS;
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
  const incomes = commitments.filter((c) => c.kind === 'income' && c.frequency === 'monthly');
  const bills = commitments.filter((c) => c.kind === 'expense');
  const goal = goals.find((g) => g.kind === 'apartment');
  const members = scope.members.filter((m) => m.status === 'active');
  const withoutIncome = members.filter((m) => !incomes.some((i) => i.memberId === m.id));

  const mark = (done: boolean) => (done ? '✅' : '⬜');
  const ownerless = scope.accounts.filter((a) => a.ownership === 'unassigned');
  const withoutDefault = members.filter((m) => {
    const eligible = scope.accounts.filter(
      (a) => a.ownerMemberId === m.id && a.kind !== 'credit_card' && a.kind !== 'reserve',
    );
    return eligible.length > 1 && !parseMemberPreferences(m.preferences).defaultAccountId;
  });
  const items = [
    `${mark(scope.accounts.length > 0)} Contas (${scope.accounts.length}) — /addconta corrente Nubank saldo=1000 padrao`,
    `${mark(ownerless.length === 0)} Dono das contas${ownerless.length ? ` (sem dono: ${ownerless.map((a) => a.name).join(', ')})` : ''} — /editconta Nome dono=Pessoa`,
    `${mark(withoutDefault.length === 0)} Conta principal de cada um${withoutDefault.length ? ` (falta: ${withoutDefault.map((m) => m.name).join(', ')})` : ''} — /contapadrao Nome`,
    `${mark(withoutIncome.length === 0)} Renda prevista${withoutIncome.length ? ` (falta: ${withoutIncome.map((m) => m.name).join(', ')})` : ''} — cada um manda /renda 4200 util=5 @Conta`,
    `${mark(bills.length > 0)} Contas fixas (${bills.length}) — "Nosso aluguel é 1200 e vence todo dia 5"`,
    `${mark(budgets.length > 0)} Orçamentos (${budgets.length}) — /orcamento delivery 250`,
    `${mark(goals.some((g) => g.progress.targetCents !== null))} Metas (${goals.length}) — /meta criar Viagem valor=8000 ou /meta entrada=VALOR`,
    `${mark(goal !== undefined && goal.emergencyReserveCents !== null)} Reserva de emergência (separada) — /meta reserva=VALOR`,
  ];
  return [
    'O que já sei e o que falta (no ritmo de vocês, dá para lançar gastos desde já):',
    ...items,
  ].join('\n');
}
