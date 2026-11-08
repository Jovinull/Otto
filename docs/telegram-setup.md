# Configurar o Telegram

Não é preciso chip ou número extra: o bot é uma conta do próprio Telegram.

## 1. Criar o bot

1. No Telegram, abra **@BotFather** e envie `/newbot`.
2. Escolha um nome (ex.: `Otto`) e um username terminado em `bot` (ex.: `otto_casa_bot`).
3. O BotFather devolve o **token** (`123456:ABC…`). Trate como senha. Não cole em chat, issue ou arquivo versionado.

## 2. Permitir que o bot leia o grupo

Por padrão (Privacy Mode ligado) bots só recebem comandos e respostas a eles. O Otto precisa ler frases comuns como "gastei 20 no almoço". Escolha uma opção:

- **Recomendado:** depois de adicionar o bot ao grupo, torne-o **administrador** (sem permissões extras). Administradores recebem todas as mensagens.
- **Alternativa:** no BotFather, `/setprivacy` → escolha o bot → `Disable`. A mudança só vale para grupos em que o bot for **removido e adicionado de novo**.

Também envie `/setjoingroups` → `Disable` depois de adicionar o bot ao grupo, para impedir que outras pessoas o adicionem em grupos delas.

## 3. Criar o grupo

1. Crie um grupo com Felipe e Jennifer.
2. Adicione o bot pelo username.
3. Aplique o passo 2 (administrador ou Privacy Mode).

Se o Telegram converter o grupo em supergrupo depois, o ID muda; o Otto acompanha a migração automaticamente pela mensagem de serviço.

## 4. Descobrir os IDs

Com o Worker publicado e o webhook configurado (passos de [deployment.md](deployment.md)), mas **antes** do bootstrap:

1. Felipe envia `/id` no grupo → o bot responde com `Chat ID` (negativo, ex.: `-1001234567890`) e o `user ID` de Felipe.
2. Jennifer envia `/id` → o bot responde o user ID dela.

Antes do bootstrap o `/id` é a única coisa que funciona, e não expõe dados financeiros. Depois do bootstrap ele só responde a membros autorizados.

## 5. Registrar os IDs

Preencha o `.env` local (que não vai para o Git):

```bash
OTTO_HOUSEHOLD_NAME=Casa Felipe e Jennifer
OTTO_TIMEZONE=America/Maceio
OTTO_TELEGRAM_CHAT_ID=-1001234567890
OTTO_MEMBER_1_NAME=Felipe
OTTO_MEMBER_1_TELEGRAM_ID=111111111
OTTO_MEMBER_2_NAME=Jennifer
OTTO_MEMBER_2_TELEGRAM_ID=222222222
```

E rode `pnpm bootstrap:household`. A resposta esperada é `HTTP 201`. Uma segunda execução devolve `409 already_bootstrapped`.

## 6. Configurar o webhook

```bash
pnpm telegram:webhook
```

O script registra `https://<seu-worker>/webhook/telegram` com `secret_token`, recebendo apenas `message`, `edited_message` e `callback_query`, com `max_connections = 1` (um update por vez, preservando a ordem), e mostra `getWebhookInfo` sem imprimir o token. Para pausar o bot sem perder dados: `pnpm telegram:webhook -- --remove`.

## 7. Verificar

- `pnpm doctor:telegram` confere token, webhook, erros de entrega, se o bot lê o grupo e quantas pessoas há nele, sem alterar nada.

- `pnpm telegram:webhook -- --info` deve mostrar a URL e `pending_update_count: 0`, sem `last_error_message`.
- No grupo: `/status` responde com "Otto ativo (production)".
- `/gasto 1 teste` registra e `/estornar CODIGO` + Confirmar desfaz.
- Uma pessoa fora da lista que mandar mensagem não recebe resposta.

Depois siga [manual-test.md](manual-test.md).
