# Roteiro de teste no grupo real

Faça com valores pequenos e estorne no final. Marque cada item. Pré-requisito: [first-deployment.md](first-deployment.md) concluído.

## 0. Verificações antes do grupo

- [ ] `pnpm doctor -- --remote` termina com `0 erro(s)`.
- [ ] `pnpm doctor:telegram` sem erros: bot lê o grupo, webhook com `max_connections = 1`, grupo com 3 membros.
- [ ] `pnpm smoke:openai -- --yes` termina com "OpenAI OK." e mostra o modelo servido.

## 1. Acesso e segurança

- [ ] Felipe: `/status` → "Otto ativo (production)", "IA: configurada".
- [ ] Uma conta de fora manda `/resumo` em conversa privada com o bot → sem resposta.
- [ ] Na máquina: `curl -X POST https://<worker>/webhook/telegram -d "{}"` → `401`.

## 2. Cadastro guiado

- [ ] `/configurar` → começa pela Etapa 1/6.
- [ ] Responda tom, renda de cada um e o dia em que cai.
- [ ] No meio do cadastro, mande "gastei 1 real de bala" → o lançamento é registrado normalmente e o cadastro continua.
- [ ] `/configurar pausar`, depois `/configurar` → continua da pergunta em que parou.
- [ ] Cadastre as contas (`corrente Nome saldo`, `cartao Nome fecha N vence N`) e "pronto".
- [ ] Contas fixas, outros compromissos ("pronto"), limites e apartamento. Use "pular" no que não souberem.
- [ ] O resumo mostra exatamente o que foi informado. Antes de confirmar, `/contas` ainda diz "Nenhuma conta cadastrada".
- [ ] Confirme → "Configuração ativada ✅". Confira com `/contas`, `/compromissos`, `/orcamento`, `/metas`.

## 3. Registros

- [ ] Felipe: "Gastei 1 real com Uber" → R$ 1,00 em Transporte, com código.
- [ ] Jennifer: "Comprei 2,50 no mercado" → atribuído a Jennifer.
- [ ] "Gastei 1 no almoço e 1,50 no estacionamento" → dois lançamentos numa resposta.
- [ ] "Transferi 1 para a reserva" → "Não conta como despesa nem receita" e lembrete do `/aporte`.
- [ ] Felipe e Jennifer lançam a mesma compra de R$ 3 → a segunda pede confirmação ("Parece repetido").
- [ ] `/gasto 12.50 teste` → pergunta se é R$ 12,50; responda "não".
- [ ] Mensagem comum ("chego às 19h") → nenhuma resposta.
- [ ] Edite uma mensagem já registrada → o Otto orienta a usar `/corrigir` e não muda o lançamento.
- [ ] Mande "/gasto 1 a" e, logo em seguida, "/gasto 2 b" → os dois são registrados, nessa ordem (`/ultimos`).

## 4. Cartão

- [ ] `/gasto 3 teste cartao` → lançado no cartão.
- [ ] `/gasto 6 teste parcelado cartao 3x` → informa em qual fatura cai a 1ª parcela.
- [ ] `/fatura` → fatura atual com R$ 5,00 (ou conforme a data) e parcelas futuras.
- [ ] `/pagar_fatura 1 <conta> para <cartão>` → `/fatura` mostra o abatimento; nenhuma despesa nova em `/resumo`.

## 5. Consultas

- [ ] "Quanto gastamos este mês?" confere com os lançamentos de teste.
- [ ] "Quanto a Jennifer gastou com mercado?"
- [ ] "Quais contas ainda precisamos pagar?"
- [ ] `/contas`: mostra dívida dos cartões e dinheiro separado para a meta, nunca "disponível".

## 6. Orçamento e meta

- [ ] Limite pequeno (`/orcamento transporte 3`) e "gastei 2 de Uber" → aviso acima de 80%; novo gasto pequeno não repete o aviso.
- [ ] `/aporte 1` → mostra a evolução e o pretendido do mês. Desfaça com `/estornar`.
- [ ] "Podemos pedir uma pizza de 90?" → resposta com números do orçamento e da renda prevista.
- [ ] "Recebi metade do salário" → o Otto pergunta o valor; informe um valor menor que o previsto → a previsão não fica marcada como recebida.

## 7. Correção e estorno

- [ ] `/corrigir CODIGO valor 2` → valor muda.
- [ ] "Apaga o último lançamento" → pede confirmação; Cancelar mantém; repita e Confirmar estorna.
- [ ] Estorne todos os lançamentos de teste e confira `/resumo`.

## 8. Resiliência (opcional)

- [ ] Remova a chave da OpenAI (`pnpm exec wrangler secret delete OPENAI_API_KEY --env production`), mande "gastei 1 no pão" → aviso de que nada foi registrado ainda; `/gasto 1 pão` funciona (pode esperar até 3 minutos atrás da mensagem anterior). Recoloque a chave → na próxima retentativa o primeiro lançamento é registrado.
- [ ] `/ia` mostra o custo do dia.

## 9. Backup

- [ ] `pnpm backup:prod` com `OTTO_BACKUP_PASSPHRASE` definida.
- [ ] `pnpm restore:test -- "<arquivo>"` termina com "Restauracao verificada."

## 10. Proativas

- [ ] Segunda-feira, entre 8h e 9h, chega o resumo semanal com "O que mais pesou".
- [ ] Três dias antes de uma conta fixa ou do vencimento da fatura, chega o lembrete às 9h.
- [ ] `/notificacoes semanal off` desliga só o resumo semanal.
