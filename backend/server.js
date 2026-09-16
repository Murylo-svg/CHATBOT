require('dotenv').config();

const express = require('express');
const cors = require('cors');

const conectarBanco = require('./config/db');
const rotasHealth = require('./routes/health');
const rotasAuth = require('./routes/auth');
const rotasChat = require('./routes/chat');

const app = express();
const PORTA = process.env.PORT || 3000;

// ---------- CORS ----------
// Lista de origens liberadas. Em dev, deixa passar qualquer localhost.
const origensPermitidas = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // Postman, curl, health checks
      if (origensPermitidas.length === 0) return callback(null, true);
      if (origensPermitidas.includes(origin)) return callback(null, true);
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
      if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return callback(null, true);
      return callback(new Error('Origem nao permitida pelo CORS: ' + origin));
    },
  })
);

app.use(express.json({ limit: '2mb' }));

// ---------- ROTAS PÚBLICAS (antes de qualquer JWT) ----------
app.use('/api', rotasHealth);

app.get('/', (req, res) => {
  res.json({
    nome: 'API do Agente de IA',
    versao: '1.0.0',
    documentacao: 'Veja o README do repositorio',
    health: '/api/health',
  });
});

// ---------- ROTAS DE AUTENTICAÇÃO (públicas) ----------
app.use('/api/auth', rotasAuth);

// ---------- ROTAS PROTEGIDAS ----------
// O middleware de JWT é aplicado dentro de routes/chat.js
app.use('/api/chat', rotasChat);

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada: ' + req.method + ' ' + req.originalUrl });
});

// ---------- Tratador global de erros ----------
app.use((erro, req, res, next) => {
  console.error('[ERRO]', erro.message);

  if (erro.message && erro.message.startsWith('Origem nao permitida')) {
    return res.status(403).json({ erro: erro.message });
  }
  if (erro.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ erro: 'Imagem muito grande. O limite e de 5 MB.' });
  }
  return res.status(500).json({ erro: 'Erro interno do servidor', detalhe: erro.message });
});

// ---------- Inicialização ----------
async function iniciar() {
  await conectarBanco();
  app.listen(PORTA, () => {
    console.log(`Servidor rodando na porta ${PORTA}`);
    console.log(`Health check: http://localhost:${PORTA}/api/health`);
  });
}

iniciar().catch((erro) => {
  console.error('Falha ao iniciar o servidor:', erro);
  process.exit(1);
});
