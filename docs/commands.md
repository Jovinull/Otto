# Comandos

Todos funcionam sem IA. Nomes com espaço podem ser escritos como foram cadastrados:
`@Mercado Pago`. Em opções com `=`, use `_` no lugar do espaço: `nome=Conta_Nova`.

## Lançamentos

| Comando                                                                                       | O que faz                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `/gasto VALOR descrição [#categoria] [@conta] [ontem\|03/11] [cartao] [6x] [casal] [de:Nome]` | registra despesa                                  |
| `/receita VALOR descrição [#categoria] [@conta] [data]`                                       | registra receita avulsa                           |
| `/transferir VALOR origem para destino`                                                       | move entre contas, sem virar gasto ou receita     |
| `/pagar_fatura VALOR conta para cartão`                                                       | paga fatura e informa se quitou                   |
| `/corrigir CÓDIGO valor\|categoria\|data NOVO`                                                | corrige lançamento                                |
| `/estornar CÓDIGO`                                                                            | anula lançamento ou aporte, com confirmação       |
| `/parcela_data CÓDIGO DD/MM/AAAA`                                                             | 1º vencimento de parcelamento sem cartão com dias |
| `/parcela_paga CÓDIGO`                                                                        | quita parcela sem cartão com dias                 |

## Consultas

| Comando                  | O que faz                                                          |
| ------------------------ | ------------------------------------------------------------------ |
| `/statuspessoal [Nome]`  | renda, gastos, contas, cartões, metas e valor potencialmente livre |
| `/statuscasal`           | o mesmo para o casal, sem somar conta compartilhada duas vezes     |
| `/resumo [MM/AAAA]`      | resumo do mês                                                      |
| `/semana`                | semana atual                                                       |
| `/comparar`              | mês atual contra o anterior                                        |
| `/contas`                | todas as contas e cartões, com reservado e livre                   |
| `/minhascontas [Nome]`   | contas e cartões da pessoa, com os padrões marcados                |
| `/compromissos`          | contas a pagar e renda prevista e recebida no mês                  |
| `/orcamento [categoria]` | situação dos orçamentos                                            |
| `/metas`, `/meta NOME`   | progresso e onde está o dinheiro                                   |
| `/fatura [cartão]`       | faturas: total, pago e pendente                                    |
| `/parcelas`              | parcelamentos ativos                                               |
| `/ultimos [N]`           | últimos lançamentos, com código                                    |
| `/categorias`            | categorias e códigos                                               |
| `/analise [pergunta]`    | análise do mês                                                     |

## Contas, renda e contas fixas

| Comando                                                                                                                                                                                    | O que faz                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `/addconta corrente\|poupanca\|dinheiro\|reserva\|conjunta\|cartao Nome [saldo=] [padrao] [alternativa] [fecha=] [vence=] [limite=] [disponivel=] [divida=] [banco=] [descricao=] [dono=]` | cria conta ou cartão                                        |
| `/contapadrao [Conta]`, `/cartaopadrao [Cartão]`                                                                                                                                           | mostra ou define o seu padrão; `de=Nome` para outra pessoa  |
| `/saldo Conta VALOR`                                                                                                                                                                       | compara com o saldo real; diferença só ajusta com aprovação |
| `/renda VALOR dia=N\|util=N [@Conta] [nome=] [de=] [irregular]`                                                                                                                            | cadastra uma fonte de renda; não registra recebimento       |
| `/recebi [nome] [valor] [@Conta]`                                                                                                                                                          | marca a renda como recebida, sem duplicar                   |
| `/recorrente VALOR dia=N\|util=N nome`                                                                                                                                                     | conta fixa; `?` no valor se variar                          |
| `/orcamento categoria VALOR [de=Nome]`                                                                                                                                                     | define limite mensal                                        |
| `/addcategoria Nome essencial\|discricionaria\|outra`                                                                                                                                      | cria categoria                                              |

## Metas

| Comando                                                     | O que faz                                                |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `/meta criar NOME valor= [prazo=MM/AAAA] [aporte=] [dono=]` | cria uma meta                                            |
| `/meta NOME valor= prazo= aporte= nome= nota=`              | altera a meta                                            |
| `/meta remover NOME`                                        | arquiva, sem mover dinheiro                              |
| `/meta entrada= custos= prazo= aporte= reserva= inicial=`   | configura o apartamento                                  |
| `/aporte [META] VALOR [@Conta] [de:Origem] [data]`          | guarda dinheiro; com `de:` faz a transferência real      |
| `/aporte META VALOR @Conta existente`                       | dinheiro que já existia; não conta como aporte do mês    |
| `/retirada [META] VALOR [@Conta]`                           | libera dinheiro da meta                                  |
| `/vincular META @Conta`                                     | define onde a meta fica; cria o cofre se ele não existir |

## Editar e remover

| Comando                                                                                                      | O que faz                           |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `/editconta Nome nome= saldo= fecha= vence= dono= banco= descricao= limite= disponivel= alternativa= padrao` | altera conta ou cartão              |
| `/removerconta Nome`                                                                                         | arquiva a conta; histórico continua |
| `/editcategoria codigo nome= tipo=`                                                                          | renomeia ou muda o tipo             |
| `/editrecorrente nome valor= dia= util=`                                                                     | altera conta fixa ou renda          |
| `/removerrecorrente nome`                                                                                    | deixa de prever                     |
| `/removerorcamento categoria\|total [de=Nome]`                                                               | remove o limite                     |

## Sistema

| Comando                                                                                        | O que faz                                          |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `/configurar [status\|pausar\|refazer\|renda\|contas\|fixas\|orcamento\|apartamento\|alertas]` | cadastro guiado                                    |
| `/tom neutro\|amigavel\|firme`                                                                 | estilo das respostas (admin)                       |
| `/notificacoes`                                                                                | mostra os avisos; `on\|off` liga e desliga (admin) |
| `/notificacoes contas\|orcamento\|semanal\|mensal\|meta\|dicas on\|off`                        | liga ou desliga um tipo                            |
| `/notificacoes contas dias=5`, `orcamento avisos=70,100`, `semanal dia=dom`, `meta dia=25`     | frequência dos avisos                              |
| `/ia`, `/status`, `/id`                                                                        | consumo de IA, saúde do Otto, IDs                  |
| `/ajuda [tema]`, `/comandos`                                                                   | ajuda                                              |

## Linguagem natural

Tudo isso também funciona escrevendo normalmente. Exemplos:

- "Gastei 27 reais com Uber", "Comprei um tênis de 300 no cartão em 3 vezes"
- "Paguei R$ 300 da fatura do PicPay", "A fatura do Nubank foi paga"
- "Meu salário caiu", "Recebi só 2.000 do salário"
- "Guardei 500 para a viagem no Cofre", "Tirei 200 da reserva de emergência"
- "Meu Nubank está com 830 agora"
- "Quanto ainda posso gastar este mês?", "Onde está o dinheiro do apartamento?"
- "Qual é a nossa situação financeira hoje?", "Podemos pedir uma pizza de 90?"
