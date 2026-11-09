# Primeira implantação do Otto

Roteiro para colocar o Otto no ar pela primeira vez. Tudo usa planos gratuitos, exceto os créditos da OpenAI (pré-pagos, poucos dólares por mês).

Os comandos rodam na pasta do projeto (`C:\Workspace\Otto`). Quando a sintaxe muda entre **PowerShell** e **Git Bash**, os dois aparecem. Nunca cole tokens ou chaves em chats, issues ou arquivos versionados.

> Tempo estimado: 40 a 60 minutos.

## 0. Preparar a máquina

```powershell
node -v            # precisa ser 22 ou maior
corepack enable    # instala o pnpm, se ainda não tiver
pnpm install
pnpm check         # testes, tipos, lint, formatação e build: tudo precisa passar
```

## 1. Criar o bot no BotFather

1. No Telegram, abra **@BotFather** e envie `/newbot`.
2. Nome: `Otto`. Username: algo terminado em `bot`, por exemplo `otto_casa_bot`.
3. Guarde o **token** que ele devolve (formato `123456:ABC...`) num gerenciador de senhas.

## 2. Configurar o Privacy Mode

O Otto precisa ler frases como "gastei 20 no almoço", não só comandos. Escolha **uma** opção:

- **Recomendado:** no passo 3, torne o bot **administrador** do grupo (sem marcar permissões extras). Administradores recebem todas as mensagens.
- **Alternativa:** no BotFather, `/setprivacy` → escolha o bot → `Disable`. Se o bot já estiver no grupo, remova-o e adicione de novo.

## 3. Criar o grupo

1. Crie um grupo com Felipe e Jennifer.
2. Adicione o bot pelo username.
3. Torne-o administrador (opção recomendada do passo 2).
4. No BotFather, `/setjoingroups` → escolha o bot → `Disable`. Assim ninguém o adiciona a outros grupos.

Não adicione outras pessoas: todos no grupo veem as respostas financeiras.

## 4. Criar a conta Cloudflare

1. Crie uma conta gratuita em https://dash.cloudflare.com/sign-up. Não é preciso cartão nem domínio.
2. Em **Workers & Pages**, abra a página uma vez para escolher seu subdomínio `*.workers.dev`.

## 5. Login no Wrangler

```powershell
pnpm exec wrangler login      # abre o navegador para autorizar
pnpm exec wrangler whoami     # confirma a conta
```

## 6. Criar o banco D1

```powershell
pnpm exec wrangler d1 create otto-prod
```

Copie o `database_id` exibido e cole em `wrangler.jsonc`, dentro de `env.production.d1_databases`, no lugar de `REPLACE_WITH_D1_DATABASE_ID`. Esse id não é segredo e pode ser versionado.

## 7. Aplicar as migrações

```powershell
pnpm db:migrate:prod
```

Confirme com `y` quando o Wrangler perguntar. Deve listar `0000`, `0001` e `0002` como aplicadas.

## 8. Publicar o Worker

```powershell
pnpm deploy:prod
```

> Use `pnpm deploy:prod`. O comando `pnpm deploy` é um comando interno do pnpm e **não** publica o Otto.

Anote a URL exibida, por exemplo `https://otto.seu-subdominio.workers.dev`. Sem segredos, o Worker já está no ar, mas recusa qualquer mensagem: é seguro.

## 9. Criar os segredos

Gere dois valores aleatórios (rode duas vezes, um para cada):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Cadastre cada segredo. O Wrangler pede o valor no terminal, e ele não aparece na tela nem no histórico:

```powershell
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN --env production       # token do passo 1
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production  # 1º valor gerado
pnpm exec wrangler secret put ADMIN_API_TOKEN --env production          # 2º valor gerado
pnpm exec wrangler secret put OPENAI_API_KEY --env production           # chave do passo 10
```

Depois, crie o arquivo local `.env`. Ele é ignorado pelo Git e é usado pelos scripts na sua máquina:

```powershell
Copy-Item .env.example .env     # PowerShell
```

```bash
cp .env.example .env            # Git Bash
```

Preencha no `.env`: `OTTO_BASE_URL` (URL do passo 8, sem barra no final), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` e `ADMIN_API_TOKEN`, com **os mesmos** valores cadastrados acima. A chave da OpenAI só vai no `.env` se você for rodar o `smoke:openai`.

## 10. Criar a chave da OpenAI

1. Em https://platform.openai.com, crie um **projeto** só para o Otto (Settings → Projects).
2. Dentro dele, em **API keys**, crie uma chave com permissão para o projeto. Guarde-a.
3. Em **Billing**, adicione créditos pré-pagos (US$ 5 bastam por meses) e **desligue a recarga automática**.

## 11. Configurar limites de gastos

- **No painel da OpenAI** (Settings → Limits do projeto): defina um orçamento mensal (ex.: US$ 5) e um alerta por e-mail. Esse é o limite real de cobrança.
- **No Otto**: `OPENAI_DAILY_BUDGET_USD` (0.30) e `OPENAI_MONTHLY_BUDGET_USD` (3) em `wrangler.jsonc`. Ao atingir, o Otto pausa a interpretação por IA e mantém os comandos funcionando. É uma estimativa local, não substitui o limite do painel.

Para conferir que chave e modelos funcionam (custa cerca de US$ 0,0003; com `--analysis`, cerca de US$ 0,01):

```powershell
pnpm smoke:openai -- --yes
```

## 12. Executar o deploy

Já foi feito no passo 8. Depois de editar `wrangler.jsonc` ou atualizar o código, repita `pnpm deploy:prod`. Segredos cadastrados continuam valendo.

Confira tudo:

```powershell
pnpm doctor -- --remote
```

Deve terminar com `0 erro(s)`.

## 13. Configurar o webhook

```powershell
pnpm telegram:webhook
```

Isso registra a URL com o segredo e com `max_connections = 1`, para o Telegram entregar uma mensagem por vez, na ordem. Em seguida:

```powershell
pnpm doctor:telegram
```

Esse diagnóstico só lê; não altera nada. O campo `OTTO_TELEGRAM_CHAT_ID` ainda está vazio, então ele avisa que não pôde checar o grupo. Isso é esperado até o passo 14.

## 14. Obter os IDs e executar o bootstrap

1. No grupo, Felipe envia `/id`. O bot responde o **Chat ID** (número negativo) e o **user ID** de Felipe.
2. Jennifer envia `/id` e anota o user ID dela.

Antes do bootstrap, `/id` é a única coisa que funciona. Ele não expõe dados e não dá permissão a ninguém.

Complete o `.env`:

```dotenv
OTTO_HOUSEHOLD_NAME=Casa Felipe e Jennifer
OTTO_TIMEZONE=America/Maceio
OTTO_TELEGRAM_CHAT_ID=-100XXXXXXXXXX
OTTO_MEMBER_1_NAME=Felipe
OTTO_MEMBER_1_TELEGRAM_ID=XXXXXXXXX
OTTO_MEMBER_2_NAME=Jennifer
OTTO_MEMBER_2_TELEGRAM_ID=XXXXXXXXX
```

Execute:

```powershell
pnpm bootstrap:household
```

A resposta esperada é `HTTP 201`. O bootstrap funciona uma única vez; uma segunda execução retorna `409 already_bootstrapped`. Ninguém mais consegue se tornar membro pelo Telegram: quem entrar no grupo depois é ignorado.

Rode de novo `pnpm doctor:telegram`. Agora ele confere o grupo, se o bot lê as mensagens e quantas pessoas há no grupo.

## 15. Testar mensagens

No grupo:

1. `/status` → "Otto ativo (production)" e "IA: configurada".
2. `/configurar` → começa o cadastro guiado (contas, renda, contas fixas, orçamento, apartamento). Dá para pausar com `/configurar pausar`.
3. "Gastei 1 real com Uber" → registra com um código `#abc123`.
4. `/estornar abc123` → Confirmar.

O roteiro completo está em [manual-test.md](manual-test.md).

## 16. Verificar erros

| Onde                                 | Comando                                    |
| ------------------------------------ | ------------------------------------------ |
| Logs ao vivo (sem dados financeiros) | `pnpm exec wrangler tail --env production` |
| Entrega do Telegram                  | `pnpm doctor:telegram`                     |
| Configuração geral                   | `pnpm doctor -- --remote`                  |
| Fila de mensagens                    | `/status` no grupo                         |
| Consumo de IA                        | `/ia` no grupo                             |

Mensagem sem resposta? Veja se `doctor:telegram` mostra `last_error_message`. Se for `401`, o segredo do webhook no Worker difere do `.env`: rode de novo `wrangler secret put TELEGRAM_WEBHOOK_SECRET` e `pnpm telegram:webhook`.

## 17. Fazer backup

Defina uma senha de backup longa, guardada só no gerenciador de senhas, e rode:

```powershell
$env:OTTO_BACKUP_PASSPHRASE = "<sua senha de backup>"   # PowerShell: vale só nesta janela
pnpm backup:prod
```

```bash
export OTTO_BACKUP_PASSPHRASE="<sua senha de backup>"   # Git Bash
pnpm backup:prod
```

O arquivo vai para `%USERPROFILE%\otto-backups` (ou `OTTO_BACKUP_DIR`), criptografado, com um manifesto. O script recusa salvar dentro do repositório.

**Teste a restauração** logo no primeiro backup. Ela usa um banco local temporário e nunca toca em produção:

```powershell
pnpm restore:test -- "$env:USERPROFILE\otto-backups\otto-prod-AAAA-MM-DDTHH-MM-SS.sql.enc"
```

Deve terminar com `Restauracao verificada.`. Frequência recomendada: semanal (ver [operations.md](operations.md#backup-e-restauração)).

## 18. Recuperar o serviço

| Situação                                         | Ação                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Versão nova com defeito                          | `pnpm exec wrangler deployments list --env production`, depois `pnpm exec wrangler rollback <id> --env production` |
| Dados apagados ou corrompidos nos últimos 7 dias | `pnpm exec wrangler d1 time-travel restore otto-prod --timestamp <ISO>`                                            |
| Perda mais antiga                                | Restaure o backup num banco **novo** ([operations.md](operations.md#restaurar-em-produção))                        |
| Mensagens paradas                                | `/status`; o Cron reprocessa a fila a cada minuto                                                                  |

## 19. Atualizar versões

```powershell
git pull                      # ou aplique as mudanças locais
pnpm install
pnpm check
pnpm backup:prod              # sempre antes de migrar
pnpm db:migrate:prod          # só se houver migração nova
pnpm deploy:prod
pnpm doctor -- --remote
```

### Atualização para contas, metas e reservas (migrações 0003 e 0004)

O código novo exige as colunas novas, e o merge publica o Worker sozinho. Por isso a ordem é:

1. Faça um backup (seção 17).
2. Aplique as migrações **antes** do merge: `pnpm db:migrate:prod`.
3. Faça o merge. As migrações só acrescentam colunas e tabelas; o Worker antigo continua
   funcionando no intervalo.
4. Defina o dono das contas antigas: elas chegam sem dono e o Otto pergunta qual usar até você
   rodar `/editconta Nome dono=Felipe` (ou `dono=casal`) e `/contapadrao Nome`.

Para reverter o código, basta voltar o Worker: as colunas novas são ignoradas pela versão
anterior.

## 20. Interromper o bot sem perder dados

1. No grupo: `/notificacoes off` (para as mensagens automáticas).
2. Na máquina: `pnpm telegram:webhook -- --remove`.

O banco continua intacto. O Telegram guarda as mensagens enviadas no grupo por até 24 h. Para voltar: `pnpm telegram:webhook` e `/notificacoes on`. Nada é apagado; só remova o Worker no painel da Cloudflare se quiser desligar de vez, e faça um backup antes.
