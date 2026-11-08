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

**Parcelamento.** Uma despesa com o valor total (competência na compra) e um plano com N parcelas que somam exatamente o total. A data da 1ª parcela fica vazia até o casal informar (`/parcela_data`). O saldo futuro de parcelas aparece como compromisso, não como gasto novo.

**Previsto vs realizado.** Receita prevista e contas recorrentes ficam em `recurring_entries` e nunca alteram saldo, totais ou orçamento. Só viram realizadas quando o casal relata o pagamento/recebimento; o lançamento é então ligado à recorrência daquele mês (se houver um único candidato cujo nome aparece na descrição). "Quinto dia útil" é calculado como 5º dia de segunda a sexta e marcado como aproximado: feriados não são considerados.

**Orçamento.** Gasto do mês = soma das despesas confirmadas no escopo (categoria e/ou pessoa). Alertas nos limiares configurados (80 e 100) e em ultrapassagem, cada um uma vez por orçamento por mês, garantido por índice único.

**Meta.** Alvo = entrada + custos da compra. Guardado = soma de aportes confirmados (`inicial=` e `/aporte`) menos retiradas. Aporte pretendido é só planejamento. Reserva de emergência fica separada e não entra na meta. Transferência para a conta reserva também não entra automaticamente. Projeções ignoram rendimento e dizem isso.

**Correção e estorno.** Corrigir valor, categoria ou data atualiza o lançamento com verificação de versão e grava auditoria (antes/depois). Estornar é exclusão lógica (`voided`) e exige confirmação; o lançamento sai dos totais, a recorrência volta a ficar em aberto e o histórico permanece. Pela IA, toda correção pede confirmação.

**Proteções contra o modelo.** Valor extraído que não aparece literalmente na mensagem exige confirmação. Confiança baixa exige confirmação. Pessoa fora do Household é recusada. Categoria desconhecida cai na regra de palavras-chave. Texto de análise que cite valor ou percentual ausente dos fatos calculados é descartado e substituído pelo relatório determinístico.

## Limitações conhecidas

- Cartão: mostra a dívida total do cartão, não a fatura separada por ciclo de fechamento. Dias de fechamento/vencimento são guardados mas ainda não usados para montar faturas.
- Parcelas: a baixa de cada parcela é manual (`/parcela_paga`); o pagamento da fatura não baixa parcelas automaticamente.
- Dia útil ignora feriados.
- Uma meta de apartamento por Household; metas genéricas existem no modelo mas sem comandos.
- O comparativo mensal compara o mesmo intervalo de dias do mês anterior e ignora categorias com menos de R$ 20 no mês anterior.
- Mensagens enviadas muito rapidamente em sequência são processadas em paralelo; uma pode ser avaliada antes de a anterior ter sido gravada.
