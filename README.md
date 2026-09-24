# 🤖 Agente de IA Multimodal

Chatbot com conta de usuário, memória persistente, análise de imagens e acesso a
dados em tempo real. Cada pessoa tem seu próprio histórico, isolado por
autenticação JWT.

> 🔗 **Aplicação:** [meu-projeto-vercel](https://chatbot-eight-mocha-65.vercel.app/)
> 🔗 **API:** [meu-backend-render](https://agente-ia-backend-y32a.onrender.com)

---

## ✨ O que ele faz

| Recurso | Como funciona |
|---|---|
| 🔐 **Contas e login** | Senha protegida com bcrypt, sessão por token JWT com validade de 7 dias |
| 🧠 **Memória** | As últimas 20 mensagens são carregadas do MongoDB e reenviadas como contexto |
| 👁️ **Visão** | A imagem sobe para o Cloudinary e vai em base64 para o Gemini analisar |
| ⚡ **Ações reais** | A IA decide sozinha chamar a função de clima quando a pergunta exige |
| 🧹 **Limpar histórico** | Apaga as mensagens no banco, não apenas na tela |
| 🩺 **Health check** | Rota pública que testa a conexão com o banco e alimenta a luz do front |

---

## 🛠️ Tecnologias

**Back-end** — Node.js, Express, Mongoose, jsonwebtoken, bcryptjs, Multer, Cloudinary SDK
**Front-end** — HTML, CSS e JavaScript puro (sem build, sem framework)
**Banco** — MongoDB Atlas
**IA** — Google Gemini (`gemini-2.0-flash`), multimodal e com function calling
**Imagens** — Cloudinary
**Clima** — Open-Meteo (API pública, não exige chave)
**Hospedagem** — Render (API) e Vercel (interface)
**Monitoramento** — UptimeRobot

---

## 📁 Estrutura

```
.
├── backend/
│   ├── config/db.js            conexão com o MongoDB
│   ├── middleware/auth.js      valida o token JWT
│   ├── models/
│   │   ├── User.js             usuário
│   │   └── Message.js          mensagem do chat
│   ├── routes/
│   │   ├── health.js           GET /api/health  (pública)
│   │   ├── auth.js             cadastro, login e perfil
│   │   └── chat.js             conversa, histórico e limpeza (protegidas)
│   ├── services/
│   │   ├── gemini.js           chamada à IA e resolução de function calling
│   │   ├── cloudinary.js       upload de imagens
│   │   └── weather.js          consulta de clima (a "ferramenta" da IA)
│   ├── server.js
│   └── .env.example
└── frontend/
    ├── index.html              login e cadastro
    ├── chat.html               conversa (protegida)
    ├── css/style.css
    └── js/
        ├── config.js           ← ÚNICO arquivo a editar no deploy
        ├── api.js              camada de acesso à API e à sessão
        ├── status.js           luz verde/vermelha
        ├── auth.js
        └── chat.js
```

---

## 🚀 Rodando na sua máquina

Você precisa do Node.js 18 ou superior.

```bash
git clone https://github.com/seu-usuario/seu-repo.git
cd seu-repo/backend

npm install
cp .env.example .env      # preencha as chaves (veja abaixo)
npm run dev               # sobe em http://localhost:3000
```

Em outro terminal, sirva o front (qualquer servidor estático serve):

```bash
cd ../frontend
npx serve .               # abre em http://localhost:3000 ou similar
```

Em `frontend/js/config.js`, deixe `API_URL = "http://localhost:3000"`.

> Abrir o `index.html` com duplo clique **não funciona** — o navegador bloqueia
> as requisições por causa do protocolo `file://`. Use um servidor local.

### As chaves que você precisa criar

| Variável | Onde conseguir |
|---|---|
| `MONGO_URI` | [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) → cluster gratuito M0 → Connect → Drivers |
| `JWT_SECRET` | Gere: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) → Create API key |
| `CLOUDINARY_URL` | [Cloudinary](https://cloudinary.com) → Dashboard → API Environment variable |

No Atlas, em **Network Access**, libere `0.0.0.0/0` — senão o Render não
consegue conectar.

---

## 📡 Endpoints

| Método | Rota | Token | O que faz |
|---|---|---|---|
| `GET` | `/api/health` | não | Status da API e do banco |
| `POST` | `/api/auth/register` | não | Cria conta. Body: `{ nome, email, senha }` |
| `POST` | `/api/auth/login` | não | Autentica. Body: `{ email, senha }` |
| `GET` | `/api/auth/me` | sim | Dados do usuário logado |
| `GET` | `/api/chat/historico` | sim | Lista as mensagens |
| `POST` | `/api/chat` | sim | Envia mensagem. `multipart/form-data`: `mensagem`, `imagem` |
| `DELETE` | `/api/chat/historico` | sim | Apaga o histórico |

Rotas com token exigem o cabeçalho `Authorization: Bearer <token>`.

Resposta do health check:

```json
{
  "status": "ok",
  "bancoDeDados": "conectado",
  "uptimeSegundos": 8412,
  "ambiente": "production",
  "timestamp": "2026-09-16T14:03:22.451Z"
}
```

Se o banco estiver fora, a mesma rota responde `503` com `"status": "erro"` — e
o servidor continua de pé.

---

## 🩺 Monitoramento

O plano gratuito do Render hiberna o serviço após 15 minutos parado, o que causa
uma espera de até 50 segundos na primeira mensagem. Um monitor HTTP no
UptimeRobot consulta `/api/health` a cada 14 minutos e mantém a instância
acordada.

A interface consulta o mesmo endpoint ao carregar e a cada minuto, mostrando uma
luz verde (*Sistema operacional*) ou vermelha (*API offline*) no canto da tela.
Clicar na luz força uma nova verificação.

---

## 👤 Autor

**[DEV.HX]** — [@Murylo-svg](https://github.com/Murylo-svg )
