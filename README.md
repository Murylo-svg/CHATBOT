# 🤖 Agente de IA Multimodal — Sala Pública em Tempo Real

Chatbot com conta de usuário, **sala pública em tempo real (Socket.io / WebSockets)**,
memória persistente, análise de imagens e acesso a dados em tempo real. Todas as
pessoas logadas conversam na mesma sala, e o **🤖 Moderador Gemini** entra na
conversa quando alguém escreve `@gemini` ou `@bot`.

> 🔗 **Aplicação:** [meu-projeto-vercel](https://chatbot-eight-mocha-65.vercel.app/)
> 🔗 **API:** [meu-backend-render](https://agente-ia-backend-y32a.onrender.com)

---

## ✨ O que ele faz

| Recurso | Como funciona |
|---|---|
| ⚡ **Tempo real** | Socket.io no mesmo servidor HTTP do Express. Mensagens chegam a todos sem F5 |
| 🔐 **Contas e login** | Senha com bcrypt, sessão por JWT (7 dias) guardado em `localStorage["token_saas"]` |
| 🛡️ **Socket autenticado** | O JWT é validado no handshake (`io.use`). Token ausente, inválido ou expirado é recusado |
| 🪪 **Identidade real** | O nome exibido vem do MongoDB, nunca do que o navegador envia |
| 🤖 **Moderador Gemini** | Só responde mensagens com `@gemini` ou `@bot`, e a resposta aparece para todos |
| 🎭 **Debate de IAs** | Gemini × ✨ Gemini 2 (ou 🌀 Mistral) debatem um tema em turnos, com intervalo para dar tempo de ler |
| 🧠 **Memória** | As últimas 20 mensagens da sala (com o nome de quem falou) vão como contexto para a IA |
| 👁️ **Visão** | A imagem vai pelo socket, é validada, sobe para o Cloudinary e segue em base64 para o Gemini |
| 🌦️ **Ações reais** | A IA chama sozinha a função de clima (Open-Meteo) quando a pergunta exige |
| 👥 **Usuários online** | Contador ao vivo de pessoas conectadas (várias abas da mesma pessoa contam uma vez) |
| 🔁 **Sem duplicatas** | Cada envio tem um `clientId`; reenvios após reconexão não duplicam no banco nem na tela |
| 🧹 **Limpar histórico** | Apaga do banco as suas mensagens e as respostas do bot a você, e some da tela de todos |
| 🩺 **Health check** | Rota pública que testa o banco e alimenta a luz do front |
| 🛡️ **RBAC** | Papéis `user` e `admin` no MongoDB; rotas administrativas exigem JWT **e** `role: "admin"` conferido no banco |
| 📊 **Painel administrativo** | `dashboard.html` com Chart.js: usuários, mensagens, tokens do Gemini, média por resposta, por dia e por hora |
| 🔢 **Tokens do Gemini** | Cada resposta guarda `tokensGastos` (do `usageMetadata` real do Google) e o painel soma no MongoDB (`$group` + `$sum`) |
| 📡 **Painel ao vivo** | Evento `novoGastoDeToken` só para a sala de administradores; os gráficos sobem sem F5 |

---

## 🛠️ Tecnologias

**Back-end** — Node.js, Express, **Socket.io 4.8**, Mongoose, jsonwebtoken, bcryptjs, Multer, Cloudinary SDK
**Front-end** — HTML, CSS e JavaScript puro + cliente Socket.io (sem build, sem framework)
**Banco** — MongoDB Atlas
**IA** — Google Gemini (modelo configurável em `GEMINI_MODEL`), multimodal e com function calling
**2ª IA** — Mistral Small (`MISTRAL_MODEL`) pelo plano gratuito da Mistral AI, usada no Debate de IAs
**Imagens** — Cloudinary
**Clima** — Open-Meteo (API pública, não exige chave)
**Hospedagem** — Render (API + WebSocket) e Vercel (interface)
**Monitoramento** — UptimeRobot

---

## 📁 Estrutura

```
.
├── backend/
│   ├── config/
│   │   ├── db.js               conexão com o MongoDB
│   │   └── cors.js             (novo) regra de CORS única para Express e Socket.io
│   │   └── fusoHorario.js      fuso dos agrupamentos por dia/hora do painel
│   ├── middlewares/
│   │   ├── auth.js             verificarToken (JWT) e autenticarToken (JWT + role do banco)
│   │   └── apenasAdmin.js      RBAC: só role "admin" passa (senão 403)
│   ├── models/
│   │   ├── Usuario.js          usuário (com role "user" | "admin")
│   │   └── Mensagem.js         mensagem (com tokensGastos, entrada/saída e modelo)
│   ├── controllers/
│   │   ├── chatController.js   chat privado, resposta ao @gemini, captura de tokens e novoGastoDeToken
│   │   └── analyticsController.js  Aggregation Pipeline do painel
│   ├── routes/
│   │   ├── health.js           GET /api/health  (pública)
│   │   ├── auth.js             cadastro, login e perfil
│   │   ├── chat.js             histórico da sala, chat privado e limpeza (protegidas)
│   │   └── analyticsRoutes.js  GET /api/analytics/tokens (JWT + admin)
│   ├── scripts/definirAdmin.js promove/rebaixa UM usuário pelo e-mail
│   ├── services/
│   │   ├── gemini.js           chamada à IA e resolução de function calling
│   │   ├── salaPublica.js      (novo) validação, persistência e Moderador Gemini
│   │   ├── debate.js           (novo) debate Gemini × Mistral com turnos e intervalo
│   │   ├── mistral.js          (novo) cliente da Mistral AI
│   │   ├── tentativas.js       (novo) novas tentativas em erros temporários
│   │   ├── cloudinary.js       upload de imagens
│   │   └── weather.js          consulta de clima (a "ferramenta" da IA)
│   ├── socket/index.js         (novo) Socket.io: autenticação, eventos e usuários online
│   ├── tests/
│   │   ├── salaTempoReal.test.js   testes da sala em tempo real e do debate
│   │   └── adminAnalytics.test.js  testes de RBAC, tokens, analytics e painel
│   ├── server.js               Express + Socket.io no mesmo servidor HTTP
│   └── .env.example
└── frontend/
    ├── index.html              login e cadastro
    ├── chat.html               sala pública (protegida)
    ├── dashboard.html          painel administrativo (Chart.js)
    ├── css/style.css
    ├── css/dashboard.css
    └── js/
        ├── config.js           ← ÚNICO arquivo a editar no deploy
        ├── api.js              acesso à API e sessão (token_saas)
        ├── status.js           luz verde/vermelha
        ├── auth.js
        ├── chat.js             cliente em tempo real
        ├── dashboard.js        painel: API, gráficos e tempo real
        └── vendor/socket.io.min.js  (novo) cliente Socket.io 4.8.4
```

---

## 🔌 Como funciona o tempo real

```
Navegador A ──novaMensagem──▶ ┌───────────────────────────┐
                              │ Render: http.createServer │
                              │   ├─ Express (REST /api)   │──▶ MongoDB Atlas
Navegador B ◀─mensagemRecebida│   └─ Socket.io (/socket.io)│──▶ Cloudinary
Navegador A ◀─mensagemRecebida└───────────────────────────┘──▶ Gemini (só com @gemini/@bot)
```

1. O front conecta com `io(API_URL, { auth: { token } })`, lendo o token de `localStorage["token_saas"]`.
2. `io.use()` valida o JWT e busca o usuário no MongoDB. Sem isso, a conexão é recusada.
3. O cliente emite `novaMensagem` → o servidor valida, grava e emite `mensagemRecebida` para todos.
4. Se o texto tiver `@gemini` ou `@bot`, o servidor chama o Gemini e emite a resposta como `🤖 Moderador Gemini`.

### Eventos

| Direção | Evento | Conteúdo |
|---|---|---|
| cliente → servidor | `novaMensagem` | `{ texto, clientId, imagem?: { dados: ArrayBuffer } }` + callback de confirmação |
| servidor → todos | `mensagemRecebida` | `{ _id, autor, usuario, nomeAutor, texto, imagemUrl, ferramentaUsada, respostaA, clientId, createdAt }` |
| servidor → todos | `usuariosOnline` | `{ total, conexoes, nomes }` |
| servidor → todos | `moderadorDigitando` | `{ ativo }` |
| cliente → servidor | `pararDebate` | encerra o debate (+ callback) |
| servidor → todos | `debateEstado` | `{ ativo, tema, iniciadoPor, turno, total, intervalo, falando, nomeFalando, proximaEm, motivo? }` |
| servidor → todos | `iaDigitando` | `{ ativo, bot, nome }` durante o debate |
| servidor → todos | `mensagensRemovidas` | `{ ids }` (após limpar histórico) |
| servidor → remetente | `erroChat` | `{ erro }` |
| servidor → remetente | `sessaoExpirada` | `{ erro }` (o JWT venceu com a aba aberta) |
| painel → servidor | `entrarPainelAdmin` | pede para receber eventos administrativos (+ callback `{ ok }` ou `{ ok: false, status: 403 }`) |
| servidor → sala `admins` | `novoGastoDeToken` | `(quantidade, { mensagemId, createdAt, dia, hora, origem, modelo })` |
| servidor → painel | `painelAdminNegado` | `{ erro }` quando o admin perde o papel com o painel aberto |

Erros de conexão chegam no `connect_error` com `err.data.codigo`:
`TOKEN_INVALIDO`, `TOKEN_EXPIRADO`, `USUARIO_INEXISTENTE` (o front volta para o login) ou
`ERRO_SERVIDOR` (o front tenta de novo).

### Segurança

- JWT validado no handshake (`io.use`) e de novo em cada envio; a conexão cai quando o token expira.
- O nome vem do banco (`Usuario.findById`), nunca do cliente nem do payload do token.
- Texto: tipo `string`, sem caracteres de controle, de 1 a 2000 caracteres. Mensagem vazia é recusada.
- Imagem: até 5 MB, formato conferido pelos bytes (JPG, PNG, GIF, WEBP), não pelo nome.
- Limite de 8 mensagens a cada 10 s por usuário. Uma pergunta ao Gemini por vez por usuário e no máximo `GEMINI_MAX_SIMULTANEAS` no servidor.
- O bot nunca é acionado pelas próprias mensagens (só mensagens humanas novas passam pelo gatilho), então não há loop.
- CORS do Socket.io usa a mesma regra do Express, e a origem também é checada no upgrade para WebSocket (`allowRequest`).
- Todas as chaves ficam nas variáveis de ambiente do back-end. O front só conhece a URL da API.
- O front escreve as mensagens com `textContent`, sem `innerHTML`, então não há XSS.

---

## 📊 Painel administrativo (RBAC + Analytics)

### Papéis (RBAC)

- O campo `role` do usuário (`models/Usuario.js`) vale `"user"` por padrão. O cadastro
  **ignora** um `role` enviado pelo cliente, e nenhuma rota da API altera esse campo.
- `autenticarToken` (`middlewares/auth.js`) valida o JWT e **busca o usuário no MongoDB**
  a cada requisição, preenchendo `req.usuario.role`. O papel não fica no token: se um admin
  for rebaixado, ele perde o acesso na próxima requisição.
- `apenasAdmin` (`middlewares/apenasAdmin.js`) deixa passar só `role === "admin"`; os demais
  recebem **403**.

```js
router.get("/tokens", autenticarToken, apenasAdmin, obterAnaliseDeTokens);
```

### Como virar administrador

Cadastre-se no app normalmente e depois promova **só a sua conta**:

- **MongoDB Atlas (pelo site):** Database → **Browse Collections** → banco do app → coleção
  **`usuarios`** → no filtro digite `{ "email": "seu@email.com" }` → **Apply** → no documento
  que aparecer, clique no lápis (**Edit**) → em `role` troque `"user"` por `"admin"` (se o
  campo não existir, **Add field** `role`, tipo String, valor `admin`) → **Update**.
- **mongosh:**
  `db.usuarios.updateOne({ email: "seu@email.com" }, { $set: { role: "admin" } })`
  (confira que a resposta tem `matchedCount: 1`).
- **Script do projeto** (usa a `MONGO_URI` do `backend/.env`):
  `cd backend && npm run admin -- seu@email.com` (para tirar: `--remover`).

Depois **saia e entre de novo** no app. O link **📊 Painel** aparece no topo do chat.

### Consumo de tokens

Cada resposta do Gemini (chat privado, `@gemini` na sala e falas do Gemini no debate) grava:

| Campo (`models/Mensagem.js`) | Origem no `usageMetadata` do Google |
|---|---|
| `tokensGastos` | `totalTokenCount` |
| `tokensEntrada` | `promptTokenCount` + `toolUsePromptTokenCount` |
| `tokensSaida` | `candidatesTokenCount` + `thoughtsTokenCount` |
| `modeloIA` | modelo que respondeu (útil para calcular custo por modelo) |

O projeto usa a API REST do Gemini, não o SDK. O serviço devolve o resultado no mesmo
formato do SDK (`result.response.usageMetadata`), e o `chatController` lê
`result.response.usageMetadata.totalTokenCount`. Quando a IA usa o clima (function calling),
a resposta passa por até 3 chamadas ao Gemini e o consumo **somado das chamadas reais** é
gravado. Sem metadados válidos, o chat responde normalmente e grava `tokensGastos: 0`:
nada é estimado. Mensagens humanas e falas do Mistral ficam com 0. O consumo nunca é
devolvido ao usuário comum (nem no REST nem no WebSocket).

### `GET /api/analytics/tokens?dias=7|30|90`

Um único `Mensagem.aggregate()` com `$facet`, calculado inteiro no MongoDB (`$group`,
`$sum`, `$dateToString`/`$hour` com fuso, `$setWindowFields` para o acumulado).
Formato da resposta (valores de exemplo, listas encurtadas):

```json
{
  "totalTokens": 18664, "totalMensagens": 62, "totalUsuarios": 2,
  "tokensPorDia":   [{ "dia": "2026-11-10", "tokens": 1150, "tokensAcumulados": 18664 }],
  "mensagensPorDia":[{ "dia": "2026-11-10", "mensagens": 4, "respostasIA": 2 }],
  "mediaTokensPorResposta": 602.1, "totalRespostasIA": 31, "respostasComTokens": 31,
  "tokensEntrada": 8500, "tokensSaida": 10164, "totalAdmins": 1,
  "ultimos7Dias": { "tokens": 9100, "mensagens": 32 }, "ultimos30Dias": { "...": "..." },
  "porHora": [{ "hora": 0, "mensagens": 0, "tokens": 0 }],
  "horarioDePico": { "hora": 8, "mensagens": 26 },
  "periodo": { "dias": 30, "inicio": "2026-10-13", "fim": "2026-11-11", "fusoHorario": "America/Sao_Paulo" },
  "geradoEm": "2026-11-11T11:08:17.000Z"
}
```

Sem token → **401**. Usuário comum → **403**. Admin → **200**.

### O painel (`frontend/dashboard.html`)

- Cards: usuários, mensagens, tokens consumidos (entrada × saída) e média por resposta da IA.
- Gráficos (Chart.js): tokens por dia (`<canvas id="graficoTokens">`), mensagens por dia e
  horários de maior atividade; filtro de 7, 30 ou 90 dias; tabela com os dados.
- **Proteção:** a Vercel serve HTML estático, então a página em si não tem dados: ela é uma
  casca. Todos os números vêm de `/api/analytics/tokens`, que o servidor só entrega para admin.
  Quem não é admin vê "Acesso restrito"; sem login, volta para a tela de entrada.
- **Ao vivo:** o painel conecta no mesmo Socket.io do chat, pede `entrarPainelAdmin` (o servidor
  confere o `role` no banco) e escuta `novoGastoDeToken`. Os cards e o gráfico de hoje sobem
  na hora; o mesmo `mensagemId` nunca conta duas vezes, e depois de cada evento (e a cada
  reconexão e a cada minuto) o painel confere tudo com a API, que é a fonte da verdade.

---

## 🎭 Debate de IAs

Duas IAs conversam entre si na sala, e todo mundo assiste. O 🤖 Gemini sempre abre
defendendo um lado. O adversário depende das variáveis do Render:

- **Sem `MISTRAL_API_KEY` (padrão):** ✨ **Gemini 2**, outra instância do Gemini com outra
  personalidade (mais direta e irônica). Funciona só com a `GEMINI_API_KEY`. Para ter cota
  separada e um estilo mais diferente, defina `GEMINI_API_KEY_2` (chave de **outro projeto**
  no Google AI Studio) e `GEMINI_MODEL_2` (outro modelo do Gemini).
- **Com `MISTRAL_API_KEY`:** 🌀 **Mistral**, da Mistral AI.

| | IA | Empresa | Onde pegar a chave (grátis) |
|---|---|---|---|
| 🤖 | Gemini (`GEMINI_MODEL`) | Google | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| 🌀 | Mistral Small (`MISTRAL_MODEL`) | Mistral AI (França) | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) (plano Experiment: sem cartão, pede verificação por telefone) |

**Como usar:** clique em **🎭 Debate de IAs**, escreva o tema e escolha quantas falas
(4 a 12) e o tempo entre elas (5 a 20 s). Ou digite na sala `@debate pizza com abacaxi?`
(usa os padrões: 8 falas, 8 s). O Gemini abre defendendo um lado, o adversário rebate com o
outro, e eles se alternam. Um painel mostra o tema, a fala atual e a contagem regressiva
até a próxima.

**Parar:** botão **Parar** no painel ou digite `@parar`. Qualquer pessoa da sala pode parar.

**Proteções:** um debate por vez; no máximo `DEBATE_TURNOS_MAX` falas; intervalo mínimo
de 3 s (protege a cota grátis das duas APIs); para sozinho se todos saírem da sala ou se uma
IA falhar de vez; as falas das IAs não acionam o `@gemini` (não há loop).

**IA sobrecarregada:** quando o Google ou a Mistral respondem "high demand" (503), limite de
requisições (429) ou outro erro temporário, a chamada é repetida até 3 vezes com espera
crescente. No debate, se ainda falhar, o painel mostra "⏳ ... está sobrecarregado. Tentando
de novo..." e o servidor espera mais (5 s, 10 s, 15 s) antes de desistir. Erros definitivos,
como chave inválida, interrompem na hora. As falas ficam salvas no
MongoDB e voltam no histórico.

---

## 🚀 Rodando na sua máquina

Você precisa do Node.js 18 ou superior.

```bash
git clone https://github.com/Murylo-svg/CHATBOT.git
cd CHATBOT/backend

npm install
cp .env.example .env      # preencha as chaves (veja abaixo)
npm run dev               # API + Socket.io em http://localhost:3000
```

Em outro terminal, sirva o front (qualquer servidor estático serve):

```bash
cd ../frontend
npx serve -l 5500 .       # abre em http://localhost:5500
```

Quando o front roda em `localhost`, o `config.js` já usa `http://localhost:3000`
automaticamente. Para testar o tempo real, abra **duas janelas** (uma delas
anônima) e entre com contas diferentes.

> Abrir o `index.html` com duplo clique **não funciona** — o navegador bloqueia
> as requisições por causa do protocolo `file://`. Use um servidor local.

### Variáveis de ambiente (backend/.env e Render)

| Variável | Obrigatória | Onde conseguir / para que serve |
|---|---|---|
| `MONGO_URI` | sim | [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) → cluster M0 → Connect → Drivers |
| `JWT_SECRET` | sim | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_EXPIRES_IN` | não | Validade do token. Padrão `7d` |
| `GEMINI_API_KEY` | sim | [Google AI Studio](https://aistudio.google.com/apikey) → Create API key |
| `GEMINI_MODEL` | não | Modelo do Gemini. Padrão `gemini-2.0-flash` |
| `GEMINI_MODEL_RESERVA` | não | Modelo usado se o principal seguir sobrecarregado ("high demand") |
| `GEMINI_MAX_SIMULTANEAS` | não | Respostas do Moderador ao mesmo tempo. Padrão `3` |
| `GEMINI_API_KEY_2` | não | Chave própria do ✨ Gemini 2 no debate (padrão: a `GEMINI_API_KEY`) |
| `GEMINI_MODEL_2` | não | Modelo do ✨ Gemini 2 (padrão: o `GEMINI_MODEL`) |
| `MISTRAL_API_KEY` | não | Se definida, o 🌀 Mistral é o adversário no lugar do Gemini 2 | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) (plano gratuito Experiment) |
| `MISTRAL_MODEL` | não | Modelo do Mistral. Padrão `mistral-small-latest` |
| `DEBATE_TURNOS` / `DEBATE_TURNOS_MAX` | não | Falas padrão (8) e máximo (20) |
| `DEBATE_INTERVALO_SEGUNDOS` | não | Tempo padrão entre falas. Padrão `8` |
| `CLOUDINARY_URL` | sim | [Cloudinary](https://cloudinary.com) → Dashboard → API Environment variable |
| `CORS_ORIGIN` | sim em produção | URL da Vercel, sem barra no final. Vale para REST e Socket.io |
| `PORT` | não | O Render define sozinho |
| `NODE_ENV` | não | `production` no Render |
| `ANALYTICS_TIMEZONE` | não | Fuso dos gráficos por dia/hora do painel. Padrão `America/Sao_Paulo` |
| `REVALIDAR_ADMINS_MS` | não | De quanto em quanto tempo a sala de admins do Socket.io é conferida no banco. Padrão `60000` |
| `MONGO_URI_TESTE` | só para `npm test` | Banco descartável (é apagado a cada execução) |
| `MONGO_AGREGACAO` | só para `npm test` | `mingo` quando o banco de teste não é um MongoDB completo (ex.: FerretDB) |

No Atlas, em **Network Access**, libere `0.0.0.0/0` — senão o Render não
consegue conectar.

---

## 🧪 Testes automatizados

Os testes sobem o servidor de verdade (Express + Socket.io), conectam clientes
Socket.io reais e simulam só o Gemini e o Cloudinary (não gastam cota).

```bash
cd backend
MONGO_URI_TESTE="mongodb://127.0.0.1:27017/chatbot-teste" npm test
```

> Use um MongoDB **local ou um banco separado**. O banco de teste é apagado.
> Sem `MONGO_URI_TESTE`, os testes são pulados.
>
> Se o banco de teste não for um MongoDB completo (por exemplo, FerretDB, que não implementa
> `$facet`, `$dateToString` e `$setWindowFields`), rode com `MONGO_AGREGACAO=mingo`: o mesmo
> pipeline do `/api/analytics` é executado pelo [mingo](https://github.com/kofrasa/mingo).
> Com um MongoDB de verdade (local ou um cluster de teste no Atlas), não use essa variável.

Cobrem: mensagem chegando na outra sessão, mensagem comum sem Gemini, `@gemini`/`@bot`
com resposta única para todos, recusa de JWT inválido/ausente/expirado/de outro
segredo/de usuário apagado, nome vindo do banco mesmo com nome falso no token ou no
payload, contador online (incluindo duas abas da mesma pessoa), reenvio e envio
simultâneo do mesmo `clientId` sem duplicar, mensagem vazia, longa ou com imagem
falsa, limite de flood, imagem para o Cloudinary e para o Gemini, histórico REST
com os mesmos `_id` do WebSocket, rotas antigas (login, `/me`, chat privado, health),
CORS e limpeza do histórico avisando a sala. Na parte administrativa: cadastro sempre
como `user` (mesmo enviando `role: "admin"`), 401/403/200 no `/api/analytics/tokens`,
admin rebaixado perdendo o acesso na hora, captura do `usageMetadata` (incluindo a soma
das chamadas com function calling e o caso sem metadados), `novoGastoDeToken` chegando só
ao painel de admin e uma vez por resposta, totais por dia/hora/média conferidos contra o
banco, fuso padrão e uma auditoria dos nomes exigidos pela rubrica.

---

## 📡 Endpoints REST

| Método | Rota | Token | O que faz |
|---|---|---|---|
| `GET` | `/api/health` | não | Status da API e do banco |
| `POST` | `/api/auth/register` | não | Cria conta. Body: `{ nome, email, senha }` |
| `POST` | `/api/auth/login` | não | Autentica. Body: `{ email, senha }` |
| `GET` | `/api/auth/me` | sim | Dados do usuário logado |
| `GET` | `/api/chat/sala?limite=100` | sim | **Novo.** Histórico inicial da sala pública |
| `GET` | `/api/chat/historico` | sim | Conversa privada com o assistente (endpoint original) |
| `POST` | `/api/chat` | sim | Conversa privada. `multipart/form-data`: `mensagem`, `imagem` |
| `DELETE` | `/api/chat/historico` | sim | Apaga suas mensagens (privadas e da sala) e avisa a sala |
| `GET` | `/api/analytics/tokens?dias=30` | sim + **admin** | Métricas do painel (401 sem token, 403 sem permissão) |

Rotas com token exigem o cabeçalho `Authorization: Bearer <token>`.
O Socket.io responde no mesmo endereço, no caminho `/socket.io`.

---

## ☁️ Deploy

O passo a passo completo está em [`GUIA-DE-DEPLOY.md`](GUIA-DE-DEPLOY.md). Resumo:

1. **GitHub** — `git push` (o `.env` está no `.gitignore`).
2. **Render** (Web Service) — Root Directory `backend`, Build `npm install`, Start `npm start`,
   variáveis da tabela acima. O Render já aceita WebSocket, sem configuração extra.
   Use **uma instância só**: o contador online e as travas do Gemini ficam na memória do processo.
3. **Vercel** — Root Directory `frontend`, sem build. Ajuste `API_URL_PRODUCAO` em `frontend/js/config.js`.
4. Volte ao Render e coloque a URL da Vercel em `CORS_ORIGIN`.

---

## 🩺 Monitoramento

O plano gratuito do Render hiberna o serviço após 15 minutos parado, o que causa
uma espera de até 50 segundos na primeira conexão. Um monitor HTTP no
UptimeRobot consulta `/api/health` a cada 14 minutos e mantém a instância
acordada. Enquanto o servidor acorda, o chat mostra **Reconectando…** e conecta
sozinho quando ele volta.

A interface consulta o mesmo endpoint ao carregar e a cada minuto, mostrando uma
luz verde (*Sistema operacional*) ou vermelha (*API offline*) no canto da tela.
Clicar na luz força uma nova verificação.

---

## 👤 Autor

**[DEV.HX]** — [@Murylo-svg](https://github.com/Murylo-svg )
