require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');

const conectarBanco = require('./config/db');
const { verificarOrigem } = require('./config/cors');
const configurarSocket = require('./socket');
const rotasHealth = require('./routes/health');
const rotasAuth = require('./routes/auth');
const rotasChat = require('./routes/chat');

const app = express();
const PORTA = process.env.PORT || 3000;

// ---------- CORS ----------
// A mesma regra (config/cors.js) vale para o Express e para o Socket.io.
// Em dev, deixa passar qualquer localhost.
app.use(cors({ origin: verificarOrigem }));

app.use(express.json({ limit: '2mb' }));

// ---------- ROTAS PÚBLICAS (antes de qualquer JWT) ----------
app.use('/api', rotasHealth);

app.get('/', (req, res) => {
  res.json({
    nome: 'API do Agente de IA',
    versao: '2.0.0',
    tempoReal: 'Socket.io no mesmo endereco (path /socket.io)',
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

// ---------- Servidor HTTP compartilhado (Express + Socket.io) ----------
// O Socket.io se pendura no MESMO servidor HTTP do Express: uma unica porta
// atende as rotas REST e as conexoes WebSocket (exigencia do Render).
const servidor = http.createServer(app);
const io = configurarSocket(servidor);
app.set('io', io); // as rotas REST podem avisar a sala (ex.: limpeza do historico)

// ---------- Inicialização ----------
async function iniciar(porta = PORTA) {
  await conectarBanco();
  await new Promise((resolve) => servidor.listen(porta, resolve));
  console.log(`Servidor HTTP + Socket.io rodando na porta ${servidor.address().port}`);
  console.log(`Health check: http://localhost:${servidor.address().port}/api/health`);
  return servidor;
}

// `node server.js` sobe o servidor; `require('./server')` (testes) apenas importa
if (require.main === module) {
  iniciar().catch((erro) => {
    console.error('Falha ao iniciar o servidor:', erro);
    process.exit(1);
  });
}

module.exports = { app, servidor, io, iniciar };
