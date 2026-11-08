# Comandos

Todos funcionam sem IA. Opções `chave=valor` podem vir em qualquer ordem. `/ajuda TEMA` mostra resumos no próprio Telegram.

## Lançamentos

| Comando                                                                                       | Exemplo                                                           |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `/gasto VALOR descrição [#categoria] [@conta] [ontem\|03/11] [cartao] [6x] [casal] [de:Nome]` | `/gasto 80 mercado de:Jennifer` · `/gasto 1200 celular cartao 6x` |
| `/receita VALOR descrição [#categoria] [@conta] [data]`                                       | `/receita 4200 salario`                                           |
| `/transferir VALOR origem para destino`                                                       | `/transferir 500 Nubank para Reserva`                             |
| `/pagar_fatura VALOR origem para cartao`                                                      | `/pagar_fatura 850 Nubank para Cartao`                            |
| `/corrigir CODIGO valor\|categoria\|data NOVO`                                                | `/corrigir a1b2c3 valor 30,00`                                    |
| `/estornar CODIGO`                                                                            | pede confirmação                                                  |
| `/parcela_data CODIGO DD/MM/AAAA`                                                             | primeiro vencimento do parcelamento                               |
| `/parcela_paga CODIGO`                                                                        | marca a próxima parcela como quitada                              |

O CODIGO aparece em cada confirmação (`#a1b2c3`) e em `/ultimos`.

## Consultas

| Comando                       | Mostra                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| `/resumo` ou `/mes [MM/AAAA]` | Entradas, saídas, resultado e categorias do mês                       |
| `/semana`                     | Semana atual (segunda a domingo)                                      |
| `/comparar`                   | Mês atual vs mesmo intervalo do mês anterior                          |
| `/individual`                 | Gastos individuais e compartilhados por pessoa                        |
| `/contas`                     | Saldos conhecidos e dívida dos cartões                                |
| `/compromissos`               | Contas em aberto e renda prevista do mês                              |
| `/orcamento [categoria]`      | Situação dos orçamentos                                               |
| `/metas`                      | Meta do apartamento                                                   |
| `/parcelas`                   | Parcelamentos ativos                                                  |
| `/ultimos [N]`                | Últimos lançamentos com código                                        |
| `/categorias`                 | Categorias e códigos                                                  |
| `/analise [pergunta]`         | Análise do mês (IA com números verificados, ou relatório puro)        |
| `/configurar`                 | O que já foi cadastrado e o que falta                                 |
| `/comandos`                   | Lista todos os comandos com uma descrição curta                       |
| `/ia`                         | Consumo estimado de IA no dia e no mês                                |
| `/status`                     | Fila, IA configurada, fuso                                            |
| `/id`                         | IDs do chat e do usuário (antes do bootstrap, responde a qualquer um) |

## Cadastro e planejamento

| Comando                                                                | Exemplo                                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/addconta tipo Nome [saldo=] [padrao] [fecha=] [vence=] [dono=]`      | `/addconta corrente Nubank saldo=1200,50 padrao` · tipos: corrente, poupanca, dinheiro, reserva, conjunta, cartao |
| `/padrao Conta`                                                        | conta padrão de quem envia                                                                                        |
| `/addcategoria Nome essencial\|discricionaria\|outra`                  | `/addcategoria Pets essencial`                                                                                    |
| `/orcamento categoria VALOR [de=Nome]`                                 | `/orcamento delivery 250` · `/orcamento total 3000`                                                               |
| `/meta entrada= custos= prazo=MM/AAAA aporte= reserva= inicial=`       | `/meta entrada=80000 prazo=12/2027`                                                                               |
| `/aporte VALOR [data]` · `/retirada VALOR` · `/desfazer_aporte CODIGO` | `/aporte 500`                                                                                                     |
| `/recorrente despesa\|receita VALOR [dia=N\|util=N] nome [de=Nome]`    | `/recorrente despesa 1200 dia=5 aluguel` · use `?` para valor variável                                            |
| `/renda VALOR dia=N\|util=N`                                           | `/renda 4200 util=5`                                                                                              |

## Editar e remover

| Comando                                                                 | Exemplo                                                                                                                                                    |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/editconta Nome [nome=] [saldo=] [fecha=] [vence=] [dono=] [padrao]`   | `/editconta Nubank fecha=5 vence=12` · `vence=-` apaga · `saldo=?` volta a desconhecido · `nome=Nubank_Felipe` (use `_` no lugar de espaço) · `dono=casal` |
| `/removerconta Nome`                                                    | arquiva após confirmação; histórico e totais continuam                                                                                                     |
| `/editcategoria codigo [nome=] [tipo=essencial\|discricionaria\|outra]` | `/editcategoria lazer nome=Passeios`                                                                                                                       |
| `/editrecorrente nome [valor=] [dia=\|util=]`                           | `/editrecorrente aluguel valor=1300 dia=10` · `valor=?` para variável                                                                                      |
| `/removerrecorrente nome`                                               | deixa de prever; pagamentos já registrados continuam                                                                                                       |
| `/removerorcamento categoria\|total [de=Nome]`                          | `/removerorcamento delivery`                                                                                                                               |

Limite de orçamento e campos da meta mudam com os próprios `/orcamento` e `/meta`. Lançamentos mudam com `/corrigir` e `/estornar`.

## Preferências (administradores)

| Comando                                                          | Efeito               |
| ---------------------------------------------------------------- | -------------------- |
| `/tom neutro\|amigavel\|firme`                                   | Estilo das respostas |
| `/notificacoes on\|off`                                          | Liga/desliga todas   |
| `/notificacoes contas\|orcamento\|semanal\|mensal\|meta on\|off` | Liga/desliga uma     |

## Linguagem natural

Mensagens comuns também funcionam: "Gastei 27 reais com Uber", "Jennifer comprou 80 no mercado", "Transferi 300 para minha reserva", "Quanto gastamos este mês?", "Podemos pedir uma pizza de 90?". Conversa sem número nem termo financeiro não é enviada à IA e não recebe resposta. Para chamar o Otto explicitamente, cite "Otto" ou responda a uma mensagem dele. Respostas curtas como "sim", "não" ou o dado pedido completam a pendência aberta de quem enviou.
