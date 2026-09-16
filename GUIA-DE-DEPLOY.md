# Guia de publicação

Siga na ordem. Do zero ao ar em mais ou menos 40 minutos.

---

## 1. Criar as contas e pegar as chaves

### MongoDB Atlas
1. Crie conta em mongodb.com/cloud/atlas
2. Crie um cluster **M0 (Free)**
3. **Database Access** → Add New Database User → anote usuário e senha
4. **Network Access** → Add IP Address → **Allow access from anywhere (0.0.0.0/0)**
   *(sem isso o Render não conecta)*
5. **Database** → Connect → Drivers → copie a connection string
6. Troque `<password>` pela senha real e adicione o nome do banco antes do `?`:
   `mongodb+srv://user:senha@cluster0.abc.mongodb.net/agente-ia?retryWrites=true&w=majority`

### Google Gemini
1. Acesse aistudio.google.com/apikey
2. **Create API key** → copie

### Cloudinary
1. Crie conta em cloudinary.com
2. No Dashboard, revele o **API Environment variable**
3. Copie o valor inteiro: `cloudinary://123456:abcdef@seu-cloud-name`

### JWT_SECRET
No terminal:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 2. Subir para o GitHub

```bash
cd seu-projeto
git init
git add .
git commit -m "Agente de IA: backend e frontend"
git branch -M main
git remote add origin https://github.com/seu-usuario/seu-repo.git
git push -u origin main
```

Antes de dar push, confira que o `.env` **não** está indo:

```bash
git status --short | grep .env
```

Só pode aparecer `.env.example`. Se aparecer `.env`, rode:

```bash
git rm --cached backend/.env
echo ".env" >> .gitignore
git commit -am "Remove .env do versionamento"
```

---

## 3. Publicar o backend no Render

1. render.com → **New** → **Web Service** → conecte o repositório
2. Configure:

   | Campo | Valor |
   |---|---|
   | Name | `agente-ia-backend` |
   | Root Directory | `backend` |
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | Free |

3. **Environment** → adicione uma a uma:

   ```
   MONGO_URI          = mongodb+srv://...
   JWT_SECRET         = (o hex que você gerou)
   JWT_EXPIRES_IN     = 7d
   GEMINI_API_KEY     = ...
   GEMINI_MODEL       = gemini-2.0-flash
   CLOUDINARY_URL     = cloudinary://...
   NODE_ENV           = production
   CORS_ORIGIN        = https://seu-projeto.vercel.app
   ```

   > Deixe o `CORS_ORIGIN` para o fim — você só saberá a URL da Vercel depois
   > do passo 4. Pode criar agora com um valor qualquer e corrigir depois.

4. **Create Web Service** e aguarde o build

5. Teste no navegador:
   `https://agente-ia-backend.onrender.com/api/health`

   Tem que aparecer o JSON com `"status": "ok"`. **Tire o print disso** — é
   uma das evidências do relatório.

   Se vier `"bancoDeDados": "desconectado"`, o problema é a `MONGO_URI` ou o
   Network Access do Atlas.

---

## 4. Publicar o frontend na Vercel

1. Edite `frontend/js/config.js`:

   ```js
   const API_URL = "https://agente-ia-backend.onrender.com";
   ```

   Sem barra no final. Commit e push.

2. vercel.com → **Add New** → **Project** → importe o repositório
3. Configure:

   | Campo | Valor |
   |---|---|
   | Framework Preset | Other |
   | Root Directory | `frontend` |
   | Build Command | *(deixe vazio)* |
   | Output Directory | *(deixe vazio)* |

4. **Deploy**
5. Copie a URL gerada e volte ao Render para ajustar `CORS_ORIGIN`.
   O Render reinicia o serviço sozinho ao salvar a variável.

---

## 5. UptimeRobot (o Desafio Hacker)

1. uptimerobot.com → conta gratuita
2. **+ New monitor**
   - Monitor type: **HTTP(s)**
   - Friendly name: `API Agente IA`
   - URL: `https://agente-ia-backend.onrender.com/api/health`
   - Monitoring interval: **14 minutos**
3. Create monitor

Depois de uns 30 minutos, tire o print do painel com o monitor em **Up**.

---

## 6. Bateria de testes

Com tudo no ar, abra a aplicação e percorra os 12 testes da matriz do
relatório. Sugestões de como executar cada um:

| Teste | Como fazer |
|---|---|
| Cadastro | Crie uma conta com um e-mail novo. Confira no Atlas se o documento apareceu em `usuarios` |
| Login | Saia e entre de novo. Deve cair direto no chat |
| Logout | Clique em Sair. No DevTools → Application → Local Storage, o `token` tem que sumir |
| Rota protegida | Copie a URL do `chat.html` e abra em aba anônima. Deve voltar para o login |
| API sem token | `curl -i https://sua-api.onrender.com/api/chat/historico` → espera `401` |
| Memória | "Meu nome é Ana." Depois: "Qual é o meu nome?" |
| Limpar histórico | Clique em Limpar, recarregue a página. Confira na coleção `mensagens` do Atlas |
| Upload | Envie a foto de uma fruta. A imagem deve aparecer no painel do Cloudinary |
| Visão | Com a imagem: "Qual a cor disso?" |
| Function calling | "Qual a temperatura em Tóquio agora?" — deve aparecer a etiqueta de consulta em tempo real |
| Health público | Abra `/api/health` em aba anônima |
| Luz verde | Carregue o chat com a API no ar |

---

## Problemas comuns

**`CORS policy: No 'Access-Control-Allow-Origin'`**
A URL da Vercel não está em `CORS_ORIGIN` no Render, ou tem barra no final.
Coloque exatamente `https://seu-projeto.vercel.app`.

**Primeira mensagem demora 50 segundos**
O Render estava dormindo. É exatamente o que o UptimeRobot resolve.

**`"bancoDeDados": "desconectado"`**
Senha errada na `MONGO_URI` (cuidado com caracteres especiais — precisam ser
codificados) ou Network Access fechado no Atlas.

**A IA responde mas não usa a ferramenta de clima**
Pergunte de forma direta: "Qual a temperatura em Tóquio agora?". Se o modelo
não existir mais, troque `GEMINI_MODEL` para `gemini-1.5-flash`.

**`Gemini: API key not valid`**
A chave não foi copiada inteira, ou a API Generative Language não está ativa no
projeto do Google Cloud vinculado.
