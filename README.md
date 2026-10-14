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
| 🎭 **Debate de IAs** | Gemini (Google) × Llama (Meta, via Groq) debatem um tema em turnos, com intervalo para dar tempo de ler |
| 🧠 **Memória** | As últimas 20 mensagens da sala (com o nome de quem falou) vão como contexto para a IA |
| 👁️ **Visão** | A imagem vai pelo socket, é validada, sobe para o Cloudinary e segue em base64 para o Gemini |
| 🌦️ **Ações reais** | A IA chama sozinha a função de clima (Open-Meteo) quando a pergunta exige |
| 👥 **Usuários online** | Contador ao vivo de pessoas conectadas (várias abas da mesma pessoa contam uma vez) |
| 🔁 **Sem duplicatas** | Cada envio tem um `clientId`; reenvios após reconexão não duplicam no banco nem na tela |
| 🧹 **Limpar histórico** | Apaga do banco as suas mensagens e as respostas do bot a você, e some da tela de todos |
| 🩺 **Health check** | Rota pública que testa o banco e alimenta a luz do front |

---

## 🛠️ Tecnologias

**Back-end** — Node.js, Express, **Socket.io 4.8**, Mongoose, jsonwebtoken, bcryptjs, Multer, Cloudinary SDK
**Front-end** — HTML, CSS e JavaScript puro + cliente Socket.io (sem build, sem framework)
**Banco** — MongoDB Atlas
**IA** — Google Gemini (modelo configurável em `GEMINI_MODEL`), multimodal e com function calling
**2ª IA** — Llama 3.3 70B (Meta) pela API gratuita da Groq (`GROQ_MODEL`), usada no Debate de IAs
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
│   ├── middleware/auth.js      valida o token JWT (HTTP e handshake do socket)
│   ├── models/
│   │   ├── User.js             usuário
│   │   └── Message.js          mensagem (privada ou da sala pública)
│   ├── routes/
│   │   ├── health.js           GET /api/health  (pública)
│   │   ├── auth.js             cadastro, login e perfil
│   │   └── chat.js             histórico da sala, chat privado e limpeza (protegidas)
│   ├── services/
│   │   ├── gemini.js           chamada à IA e resolução de function calling
│   │   ├── salaPublica.js      (novo) validação, persistência e Moderador Gemini
│   │   ├── debate.js           (novo) debate Gemini × Llama com turnos e intervalo
│   │   ├── groq.js             (novo) cliente da Groq (Llama)
│   │   ├── cloudinary.js       upload de imagens
│   │   └── weather.js          consulta de clima (a "ferramenta" da IA)
│   ├── socket/index.js         (novo) Socket.io: autenticação, eventos e usuários online
│   ├── tests/salaTempoReal.test.js  (novo) testes de integração
│   ├── server.js               Express + Socket.io no mesmo servidor HTTP
│   └── .env.example
└── frontend/
    ├── index.html              login e cadastro
    ├── chat.html               sala pública (protegida)
    ├── css/style.css
    └── js/
        ├── config.js           ← ÚNICO arquivo a editar no deploy
        ├── api.js              acesso à API e sessão (token_saas)
        ├── status.js           luz verde/vermelha
        ├── auth.js
        ├── chat.js             cliente em tempo real
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

## 🎭 Debate de IAs

Duas IAs diferentes e gratuitas conversam entre si na sala, e todo mundo assiste:

| | IA | Empresa | Onde pegar a chave (grátis) |
|---|---|---|---|
| 🤖 | Gemini (`GEMINI_MODEL`) | Google | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| 🦙 | Llama 3.3 70B (`GROQ_MODEL`) | Meta, rodando na Groq | [console.groq.com/keys](https://console.groq.com/keys) |

**Como usar:** clique em **🎭 Debate de IAs**, escreva o tema e escolha quantas falas
(4 a 12) e o tempo entre elas (5 a 20 s). Ou digite na sala `@debate pizza com abacaxi?`
(usa os padrões: 8 falas, 8 s). O Gemini abre defendendo um lado, o Llama rebate com o
outro, e eles se alternam. Um painel mostra o tema, a fala atual e a contagem regressiva
até a próxima.

**Parar:** botão **Parar** no painel ou digite `@parar`. Qualquer pessoa da sala pode parar.

**Proteções:** um debate por vez; no máximo `DEBATE_TURNOS_MAX` falas; intervalo mínimo
de 3 s (protege a cota grátis das duas APIs); para sozinho se todos saírem da sala ou se uma
IA falhar; as falas das IAs não acionam o `@gemini` (não há loop). As falas ficam salvas no
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
| `GEMINI_MAX_SIMULTANEAS` | não | Respostas do Moderador ao mesmo tempo. Padrão `3` |
| `GROQ_API_KEY` | para o debate | [console.groq.com/keys](https://console.groq.com/keys) (grátis, sem cartão) |
| `GROQ_MODEL` | não | Modelo da Groq. Padrão `llama-3.3-70b-versatile` |
| `DEBATE_TURNOS` / `DEBATE_TURNOS_MAX` | não | Falas padrão (8) e máximo (20) |
| `DEBATE_INTERVALO_SEGUNDOS` | não | Tempo padrão entre falas. Padrão `8` |
| `CLOUDINARY_URL` | sim | [Cloudinary](https://cloudinary.com) → Dashboard → API Environment variable |
| `CORS_ORIGIN` | sim em produção | URL da Vercel, sem barra no final. Vale para REST e Socket.io |
| `PORT` | não | O Render define sozinho |
| `NODE_ENV` | não | `production` no Render |
| `MONGO_URI_TESTE` | só para `npm test` | Banco descartável (é apagado a cada execução) |

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

Cobrem: mensagem chegando na outra sessão, mensagem comum sem Gemini, `@gemini`/`@bot`
com resposta única para todos, recusa de JWT inválido/ausente/expirado/de outro
segredo/de usuário apagado, nome vindo do banco mesmo com nome falso no token ou no
payload, contador online (incluindo duas abas da mesma pessoa), reenvio e envio
simultâneo do mesmo `clientId` sem duplicar, mensagem vazia, longa ou com imagem
falsa, limite de flood, imagem para o Cloudinary e para o Gemini, histórico REST
com os mesmos `_id` do WebSocket, rotas antigas (login, `/me`, chat privado, health),
CORS e limpeza do histórico avisando a sala.

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
