# Roteiro de teste no grupo real

Faça com valores pequenos e estorne no final. Marque cada item.

## 1. Acesso e segurança

- [ ] Felipe: `/status` → "Otto ativo (production)", "IA: configurada".
- [ ] Peça a alguém de fora (ou a uma segunda conta) para mandar `/resumo` em conversa privada com o bot → sem resposta.
- [ ] `curl -X POST https://<worker>/webhook/telegram -d '{}'` → `401`.

## 2. Cadastro

- [ ] `/configurar` mostra a lista do que falta.
- [ ] `/addconta corrente <banco do Felipe> saldo=<saldo real ou omita> dono=Felipe`
- [ ] `/addconta corrente <banco da Jennifer> dono=Jennifer`
- [ ] `/addconta reserva Reserva saldo=<valor>` e, se usarem, `/addconta cartao <nome> fecha=<dia> vence=<dia>`
- [ ] Cada um: `/padrao <sua conta>` e `/renda <valor> util=5` (ou `dia=N`).
- [ ] "Nosso aluguel é <valor> e vence todo dia <N>" → "Compromisso anotado… É previsão".

## 3. Registros

- [ ] Felipe: "Gastei 1 real com Uber" → confirma R$ 1,00 em Transporte com código.
- [ ] Jennifer: "Comprei 2,50 no mercado" → atribuído a Jennifer.
- [ ] "Gastei 1 no almoço e 1,50 no estacionamento" → dois lançamentos numa resposta.
- [ ] "Transferi 1 para a reserva" → "Não conta como despesa nem receita".
- [ ] `/gasto 12.50 teste` → pergunta se é R$ 12,50; responda "não".
- [ ] Mensagem comum ("chego às 19h") → nenhuma resposta.
- [ ] Edite uma mensagem já registrada → Otto orienta a usar `/corrigir`, sem mudar o lançamento.

## 4. Consultas

- [ ] "Quanto gastamos este mês?" — confira com os lançamentos de teste.
- [ ] "Quanto a Jennifer gastou com mercado?"
- [ ] "Quais contas ainda precisamos pagar?"
- [ ] `/contas`, `/resumo`, `/ultimos`.

## 5. Orçamento e meta

- [ ] `/orcamento transporte 3` e depois "gastei 2 de Uber" → aviso de uso acima de 80%.
- [ ] Novo gasto pequeno em transporte → não repete o aviso de 80%.
- [ ] `/meta entrada=<valor> prazo=MM/AAAA aporte=<valor>` → `/metas` mostra guardado R$ 0,00.
- [ ] `/aporte 1` → `/metas` mostra R$ 1,00. Desfaça com `/desfazer_aporte`.
- [ ] "Podemos pedir uma pizza de 90?" → resposta com números do orçamento.

## 6. Correção e estorno

- [ ] `/corrigir CODIGO valor 2` → valor muda.
- [ ] "Apaga o último lançamento" → pede confirmação; Cancelar mantém; repita e Confirmar estorna.
- [ ] Estorne todos os lançamentos de teste e confira `/resumo`.

## 7. Resiliência (opcional)

- [ ] Remova temporariamente a chave da OpenAI (`wrangler secret delete OPENAI_API_KEY --env production`), mande "gastei 1 no pão" → aviso de que nada foi registrado ainda; `/gasto 1 pão` funciona. Recoloque a chave → na próxima retentativa (minutos, conforme o backoff) o primeiro lançamento é registrado.
- [ ] `/ia` mostra custo do dia.

## 8. Proativas

- [ ] Na segunda-feira seguinte, entre 8h e 9h, chega o resumo semanal (se houve lançamentos).
- [ ] Três dias antes do vencimento do aluguel, chega o lembrete às 9h.
- [ ] `/notificacoes semanal off` desliga só o resumo semanal.
