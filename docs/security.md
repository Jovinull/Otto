# Segurança e privacidade

## Proteções implementadas

| Ameaça                                                     | Proteção                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requisição forjada ao webhook                              | `X-Telegram-Bot-Api-Secret-Token` obrigatório, comparado por hash SHA-256 em tempo constante. Sem secret configurado, o webhook recusa tudo.                                                                                                                                                 |
| Payload malicioso ou gigante                               | Limite de 64 KB, JSON validado com Zod, texto acima de 4096 caracteres descartado, acima de 800 não vai à IA.                                                                                                                                                                                |
| Pessoa estranha no grupo, grupo estranho, conversa privada | Autorização exige chat cadastrado **e** remetente ativo no mesmo Household. Não autorizados não geram escrita nem resposta. A autorização é refeita no processamento (revogação vale para eventos na fila).                                                                                  |
| Tomada de controle no início                               | Sem bootstrap, nada financeiro funciona; só `/id` responde. O bootstrap exige `ADMIN_API_TOKEN` e funciona uma única vez. `/start` não concede nada.                                                                                                                                         |
| Escrita por perfil sem permissão                           | `viewer` só consulta; configurações exigem `admin`; confirmação pendente só pode ser respondida por quem pediu ou por admin.                                                                                                                                                                 |
| Replay e duplicação                                        | `update_id` único, `(chat, message_id)` único, chave de idempotência por lançamento, alertas e mensagens proativas com chave única.                                                                                                                                                          |
| Prompt injection                                           | Mensagem enviada ao modelo como dado JSON separado das instruções; saída validada por schema estrito; só as intenções do roteador existem; valores conferidos contra o texto; destrutivo sempre pede confirmação; análise com número não verificável é descartada. Nenhum SQL vem do modelo. |
| Acesso cruzado entre Households                            | Toda consulta filtra por `household_id`; códigos curtos validados com regex antes da consulta. Testado com dois Households.                                                                                                                                                                  |
| SQL injection                                              | Somente consultas parametrizadas do Drizzle/D1.                                                                                                                                                                                                                                              |
| Formatação injetada na resposta                            | Mensagens enviadas como texto puro, sem `parse_mode`.                                                                                                                                                                                                                                        |
| Vazamento por logs                                         | Logs estruturados com código de erro, sem texto, valor ou token. Erros de rede do Telegram não propagam a URL (que contém o token).                                                                                                                                                          |
| Segredos no Git                                            | Segredos via `wrangler secret put`; `.env`, `.dev.vars`, `*.pem`, `backups/` no `.gitignore`.                                                                                                                                                                                                |
| Rotas administrativas                                      | `Bearer ADMIN_API_TOKEN` comparado em tempo constante; exclusão exige ainda o nome exato do Household.                                                                                                                                                                                       |

## Privacidade

- **Telegram:** grupos não têm criptografia ponta a ponta. O conteúdo fica nos servidores do Telegram como qualquer mensagem de grupo. O bot precisa ler as mensagens do grupo (Privacy Mode desligado ou bot como administrador).
- **OpenAI:** apenas mensagens que passam pelo filtro local (número ou termo financeiro, ou que citam o Otto) são enviadas, junto com no máximo 300 caracteres da mensagem do Otto que está sendo respondida. Análises enviam somente agregados (totais por categoria, orçamentos, meta), sem descrições de lançamentos nem nomes de contas. As chamadas usam `store: false`, o que desativa o armazenamento de estado da resposta, mas **não** elimina a retenção para monitoramento de abuso (até 30 dias, conforme a política da OpenAI) nem cache de prompt temporário. Zero Data Retention exige aprovação comercial da OpenAI.
- **Banco:** o texto da mensagem fica no inbox só até o processamento terminar; o texto da resposta fica no outbox só até a entrega. Eventos e outbox são apagados após 90 dias. Lançamentos guardam apenas a descrição curta.
- **Não armazenados:** senhas bancárias, códigos, tokens de banco, números de cartão. Não há integração bancária.
- **Exportação:** `GET /admin/export` (JSON) e `pnpm backup`.
- **Exclusão definitiva:** `POST /admin/erase` com `{"confirmHouseholdName": "<nome exato>"}` e o token de admin. Apaga todas as tabelas do Household, inclusive auditoria. Backups já gerados e o Time Travel do D1 (7 dias) não são afetados.

Felipe e Jennifer devem estar cientes desses pontos antes de usar.

## Riscos remanescentes

- Quem tiver o `ADMIN_API_TOKEN` pode exportar e apagar tudo. Guarde-o como senha.
- Quem tiver acesso ao celular desbloqueado de um dos dois pode operar pelo Telegram.
- Respostas aparecem para todos no grupo; não adicione outras pessoas.
- Entrega de respostas é "pelo menos uma vez": raramente uma confirmação pode aparecer duplicada (o lançamento não).
- O limite de custo é uma estimativa local com preços configurados; não substitui o limite no painel da OpenAI.
- O plano gratuito limita CPU a 10 ms por invocação; em pico, o processamento pode cair para o Cron (atraso de até 2 minutos), sem perda de dados.
