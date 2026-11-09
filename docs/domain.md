# Domínio financeiro

Toda regra abaixo está no código do backend. O modelo de IA apenas propõe uma intenção estruturada, e ela passa por `resolveDraft` (`src/domain/finance/transactions.ts`) como qualquer comando.

## Entidades

| Tabela                                       | Papel                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `households`                                 | Casa: nome, moeda BRL, fuso (`America/Maceio`), chat autorizado, configurações (tom, limiares, notificações).                                |
| `household_members`                          | Pessoas autorizadas por **Telegram user ID** (nunca username), papel `admin`/`member`/`viewer`, status.                                      |
| `financial_accounts`                         | Corrente, poupança, dinheiro, reserva, conjunta, cartão. Saldo inicial opcional.                                                             |
| `categories`                                 | Categorias de despesa (essencial, discricionária, outra) e de receita.                                                                       |
| `financial_transactions`                     | Movimentações efetivas, em centavos inteiros, com data financeira local, origem, mensagem de origem, chave de idempotência, status e versão. |
| `installment_plans`, `installments`          | Cronograma de parcelas de uma compra no cartão.                                                                                              |
| `budgets`, `budget_alerts`                   | Limite mensal e registro de alertas já enviados por período e limiar.                                                                        |
| `financial_goals`, `goal_contributions`      | Meta e aportes confirmados.                                                                                                                  |
| `recurring_entries`, `recurring_settlements` | Compromissos/receitas previstos e baixa por mês.                                                                                             |
| `pending_actions`                            | Interpretações aguardando confirmação ou dado faltante (expiram em 24 h).                                                                    |
| `incoming_events`, `outgoing_messages`       | Inbox e outbox duráveis.                                                                                                                     |
| `audit_events`                               | Quem alterou o quê (só campos alterados, nunca o texto da mensagem).                                                                         |
| `ai_usage`                                   | Modelo, tokens, custo estimado em micro-dólares, resultado.                                                                                  |

Restrições no próprio banco: valor > 0, forma de cada tipo (transferência exige origem e destino distintos e não tem categoria; receita não tem origem; despesa não tem destino), chaves de idempotência únicas, um orçamento ativo por escopo, uma recorrência ativa por nome e pessoa.

## Regras

**Valores.** Inteiros em centavos. Aceitos: `25`, `25,50`, `R$ 25,50`, `1.250,00`, `1.250`, `2 mil`, `2k`. Ambíguos (`12.50`, `1,250`) nunca são gravados sem o usuário confirmar o valor. Percentuais são truncados (79,9% aparece como 79%).

**Datas.** A data financeira é civil (`YYYY-MM-DD`) no fuso do Household, calculada a partir da **hora de envio da mensagem**, não da hora de processamento: uma mensagem reprocessada dois dias depois mantém a data certa. "Ontem", "anteontem", "segunda", "03/11", "dia 3" são resolvidos; "semana passada" pede o dia exato; datas futuras são recusadas para gastos realizados.

**Receita.** Entra na conta indicada ou na conta padrão. Conta padrão segue, em ordem: preferência do membro (`/padrao`), conta marcada como padrão, única conta do membro, única conta da casa. Se houver várias contas sem regra, o Otto pergunta. Sem nenhuma conta cadastrada, registra sem conta (os totais funcionam, saldos não).

**Despesa.** Igual à receita, com a conta de origem. Atribuída ao remetente, ou a quem a mensagem nomeia ("Jennifer comprou…", "minha esposa…").

**Transferência.** Tipo próprio (`transfer/internal`). Não entra em receita, despesa nem orçamento. Move saldo entre contas sem criar dinheiro.

**Cartão de crédito.** A compra é a despesa (competência na data da compra) e aumenta a dívida do cartão. O pagamento da fatura é transferência `card_payment` da conta para o cartão: reduz a dívida e o saldo da conta, sem nova despesa. Assim compra + fatura nunca duplicam o gasto. Compra no crédito sem cartão cadastrado é recusada.

**Fatura.** Com `fecha=` e `vence=` cadastrados, cada compra pertence a um ciclo. Regra adotada: compras até a véspera do dia de fechamento entram na fatura que fecha naquele mês; compras no dia do fechamento ou depois vão para a seguinte. Alguns bancos tratam o próprio dia do fechamento de outro jeito; se o de vocês for diferente, ajuste o dia cadastrado. O vencimento cai no mesmo mês do fechamento quando o dia de vencimento é maior que o de fechamento, e no mês seguinte caso contrário. Dias 29 a 31 se ajustam a meses curtos. Pagamentos abatem as faturas da mais antiga para a mais nova; pagamento parcial deixa a fatura "paga em parte", com o valor que falta, e pagamento a mais vira crédito. `/fatura` mostra a última fatura fechada, a atual, faturas anteriores em aberto e parcelas futuras. Juros, multa, IOF e anuidade são lançados como gastos separados no cartão (categoria Juros e encargos); nada é calculado ou presumido.

**Parcelamento.** Uma despesa com o valor total (competência na compra) e um plano com N parcelas que somam exatamente o total. Cada parcela cai num ciclo de fatura consecutivo. Se o cartão tem dias cadastrados, os vencimentos são calculados por esse ciclo; se não tem, ficam vazios até o casal informar (`/parcela_data`) ou cadastrar os dias. O saldo futuro de parcelas aparece como compromisso, não como gasto novo. Orçamentos contam o valor total no mês da compra.

**Previsto vs realizado.** Receita prevista e contas recorrentes ficam em `recurring_entries` e nunca alteram saldo, totais ou orçamento. Só viram realizadas quando o casal relata o pagamento/recebimento; o lançamento é então ligado à recorrência daquele mês (se houver um único candidato cujo nome aparece na descrição). Pagamento ou recebimento parcial não quita a previsão: a baixa só acontece quando a soma dos lançamentos correspondentes do mês alcança o valor previsto (recorrências de valor variável são quitadas pelo primeiro pagamento). "Quinto dia útil" é calculado como 5º dia de segunda a sexta e marcado como aproximado: feriados não são considerados.

**Orçamento.** Gasto do mês = soma das despesas confirmadas no escopo (categoria e/ou pessoa). Orçamento individual conta só os gastos individuais da pessoa; gastos marcados como do casal (`casal`, "a gente gastou") entram nos orçamentos da casa. Alertas nos limiares configurados (80 e 100) e em ultrapassagem, cada um uma vez por orçamento por mês, garantido por índice único.

**Meta.** Alvo = entrada + custos da compra. Guardado = soma de aportes confirmados (`inicial=` e `/aporte`) menos retiradas. "Realizado no mês" conta só aportes feitos no mês; o saldo inicial já existente não entra. Aporte pretendido é só planejamento. Reserva de emergência fica separada e não entra na meta. Transferência para a conta reserva também não entra automaticamente. Projeções ignoram rendimento e dizem isso.

**Correção e estorno.** Corrigir valor, categoria ou data atualiza o lançamento com verificação de versão e grava auditoria (antes/depois). Estornar é exclusão lógica (`voided`) e exige confirmação; o lançamento sai dos totais, a recorrência volta a ficar em aberto e o histórico permanece. Pela IA, toda correção pede confirmação.

**Saldos.** `/contas` mostra o saldo conhecido de cada conta, a dívida total nos cartões (inclusive parcelas futuras) e o dinheiro já separado para metas. O Otto nunca chama a soma das contas de "disponível para gastar": dinheiro da meta pode estar numa dessas contas e há contas e faturas a pagar.

**Lançamentos duplicados.** Um lançamento com o mesmo tipo, valor e data feito pela outra pessoa nas últimas 12 horas, ou pela mesma pessoa nos últimos 2 minutos, pede confirmação antes de ser gravado.

**Cadastro guiado.** `/configurar` pergunta tom, renda, contas, contas fixas, limites e meta, guardando um rascunho. Nada é gravado no domínio antes do resumo final ser confirmado; a confirmação grava tudo numa transação. Valores pulados não são presumidos.

**Proteções contra o modelo.** Valor extraído que não aparece literalmente na mensagem exige confirmação. Confiança baixa exige confirmação. Pessoa fora do Household é recusada. Categoria desconhecida cai na regra de palavras-chave. Texto de análise que cite valor ou percentual ausente dos fatos calculados é descartado e substituído pelo relatório determinístico. Compromisso sem dia nem recorrência ("vou receber 800 semana que vem", "a luz veio 187") não vira previsão mensal: o Otto pergunta se é recorrente.

## Contas, metas e reservas

**Dono da conta.** Toda conta é de uma pessoa, do casal ou fica sem dono (`unassigned`, dados
anteriores a esta versão). A identidade é dono + tipo (cartão ou conta) + nome, então Felipe e
Jennifer podem ter cada um o seu Nubank.

**Escolha da conta em Pix e débito**, nesta ordem: conta citada; padrão individual; única conta
própria elegível; conta do casal marcada como alternativa; senão o Otto pergunta. A conta pessoal
de outra pessoa nunca é escolhida sozinha. Pagar com uma conta não define quem é responsável pela
despesa. Cartão segue a mesma ideia com o cartão padrão de quem pagou.

**Crédito.** Crédito explícito sem número de parcelas é uma parcela só. "Comprei por R$ 90" sem
falar em cartão não é crédito. A divisão de parcelas é exata em centavos.

**Limite não é dinheiro.** Limite e disponível informados aparecem em `/minhascontas` e nunca
entram em saldo ou patrimônio. Dívida informada no cadastro entra na fatura do período.

**Faturas e parcelas.** Pagar fatura é transferência, não despesa nova: a compra já contou no dia
em que foi feita. Em cartão com fechamento e vencimento cadastrados, a parcela é quitada pelo
pagamento das faturas e `/parcela_paga` é recusado, para que marcar a parcela e pagar a fatura
não contem o mesmo dinheiro duas vezes.

**Metas.** `goal_contributions` é o livro-razão de cada meta, com a conta onde o dinheiro está.

| Tipo           | Significado                                 | Conta no aporte do mês |
| -------------- | ------------------------------------------- | ---------------------- |
| `contribution` | dinheiro guardado agora                     | sim                    |
| `allocation`   | dinheiro que já existia passa a ser da meta | não                    |
| `initial`      | saldo informado ao configurar o apartamento | não                    |

**Reservar não cria dinheiro.** O reservado é parte do saldo da própria conta: R$ 3.000 em três
contas reservados para o apartamento são R$ 3.000 de patrimônio e R$ 3.000 reservados. Saldo não
muda sem transferência explícita. Com saldo conhecido, reservar acima do livre é recusado; com
saldo desconhecido, a reserva é aceita avisando que não foi possível validar. Gasto ou
transferência que consome dinheiro reservado pede confirmação e avisa o quanto ficou descoberto.

**Reconciliação.** `/saldo` compara o calculado com o informado. Diferença vira um ajuste separado
e auditável, só com aprovação; os lançamentos não mudam e a causa nunca é presumida. Conta sem
saldo conhecido apenas passa a ter saldo a partir do valor informado.

**Renda.** Configurar uma renda nunca registra recebimento. Sem valor, "meu salário caiu" usa o
previsto apenas quando a fonte é inequívoca, e pede confirmação. Recebimento parcial não quita a
previsão do mês. Renda `irregular` fica fora da previsão mensal.

**Potencialmente livre** (`/statuspessoal`, `/statuscasal`) é saldo livre conhecido menos contas a
pagar do mês menos fatura a pagar. A premissa aparece junto do número, e contas sem saldo
conhecido são listadas à parte. Não é previsão de gastos futuros.

**Alertas proativos.** Lembretes de contas e faturas, orçamento, resumo semanal, fechamento mensal,
acompanhamento de metas (a partir do dia 20), saldos divergentes sem decisão e observações
semanais de gastos. Tendência só aparece com três meses de histórico. Tudo é calculado sem IA e
cada aviso tem chave de deduplicação.

## Limitações conhecidas

- Fatura: a regra do dia de fechamento é a mesma para todos os cartões; pagamentos são abatidos por ordem cronológica, sem indicar a qual fatura o casal quis pagar.
- Parcelas: a marcação de parcela quitada (`/parcela_paga`) é manual e independente do abatimento da fatura.
- Dia útil ignora feriados.
- Uma meta de apartamento por Household; metas genéricas existem no modelo mas sem comandos.
- O comparativo mensal compara o mesmo intervalo de dias do mês anterior e ignora categorias com menos de R$ 20 no período anterior.
- Uma mensagem que falha por mais de 3 minutos deixa de bloquear as seguintes; se ela for processada depois, sai fora de ordem (correções pela IA sempre pedem confirmação mostrando o lançamento afetado).
- Nomes dos membros e fuso horário só mudam direto no banco.
