/**
 * Testes da sprint "Dashboard Administrativo, RBAC e Analytics de IA".
 *
 * Sobem o servidor real (Express + Socket.io) contra um MongoDB de teste.
 * Gemini, Cloudinary e o servico de clima sao simulados. A simulacao do Gemini
 * devolve um usageMetadata no formato da API REST do Google.
 *
 * Uso:  MONGO_URI_TESTE="mongodb://127.0.0.1:27017/chatbot-teste" npm test
 * ATENCAO: o banco de teste e APAGADO a cada execucao. Nunca use o banco de producao.
 *
 * MONGO_AGREGACAO=mingo: executa o pipeline do /api/analytics com o mingo (motor de
 * agregacao em JS) em vez do servidor de banco. Use com bancos de teste que nao
 * implementam $facet/$dateToString/$setWindowFields (ex.: FerretDB). Com um MongoDB
 * de verdade (local ou Atlas de teste), deixe sem essa variavel.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config();
const MONGO_URI_TESTE = process.env.MONGO_URI_TESTE;
if (!MONGO_URI_TESTE) {
  test('dashboard administrativo', { skip: 'defina MONGO_URI_TESTE para rodar' }, () => {});
  return;
}

process.env.MONGO_URI = MONGO_URI_TESTE;
process.env.JWT_SECRET = 'segredo-de-teste-admin-' + Date.now();
process.env.GEMINI_API_KEY = 'chave-falsa';
process.env.MISTRAL_API_KEY = '';
process.env.API_ESPERA_BASE_MS = '10';
process.env.ANALYTICS_TIMEZONE = 'America/Sao_Paulo';

// ---------- Simulacoes (antes de carregar o servidor) ----------
const cloudinary = require('../services/cloudinary');
cloudinary.enviarImagem = async () => 'https://res.cloudinary.com/teste/image/upload/x.png';

const chamadasGemini = [];
// Fila de respostas do Gemini; sem nada na fila, responde texto com usageMetadata padrao
const respostasGemini = [];
const USO_PADRAO = { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 };
const fetchOriginal = global.fetch;
global.fetch = async (url, opcoes) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    chamadasGemini.push(JSON.parse(opcoes.body));
    const r = respostasGemini.shift() || { texto: 'Resposta do Gemini.', uso: USO_PADRAO };
    const corpo = {
      candidates: [{ content: { role: 'model', parts: r.funcao ? [{ functionCall: r.funcao }] : [{ text: r.texto }] } }],
    };
    if (r.uso) corpo.usageMetadata = r.uso;
    return new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('geocoding-api.open-meteo.com')) {
    return new Response(JSON.stringify({ results: [{ name: 'Toquio', country: 'Japao', latitude: 35.6, longitude: 139.7 }] }));
  }
  if (u.includes('api.open-meteo.com')) {
    return new Response(
      JSON.stringify({
        current: { temperature_2m: 20, apparent_temperature: 19, relative_humidity_2m: 50, weather_code: 1, wind_speed_10m: 5, time: 'agora' },
      })
    );
  }
  return fetchOriginal(url, opcoes);
};

const mongoose = require('mongoose');
const { io: conectar } = require('socket.io-client');
const Mensagem = require('../models/Mensagem');
const Usuario = require('../models/Usuario');

if (process.env.MONGO_AGREGACAO === 'mingo') {
  // So o "motor" muda: o pipeline enviado e exatamente o do analyticsController
  const { Aggregator } = require('mingo');
  Mensagem.aggregate = async (pipeline) => new Aggregator(pipeline).run(await Mensagem.find().lean());
}

const { servidor, io, iniciar } = require('../server');
const { extrairTokensGastos } = require('../controllers/chatController');

let base;
const abertos = [];

// ---------- Utilitarios ----------
async function api(caminho, { metodo = 'GET', token, corpo, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (corpo) headers['Content-Type'] = 'application/json';
  const r = await fetchOriginal(base + caminho, { method: metodo, headers, body: form || (corpo ? JSON.stringify(corpo) : undefined) });
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    /* sem corpo */
  }
  return { status: r.status, dados };
}

async function cadastrar(nome, extra = {}) {
  const email = `${nome.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@teste.com`;
  const r = await api('/api/auth/register', { metodo: 'POST', corpo: { nome, email, senha: 'senha123', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return { token: r.dados.token, usuario: r.dados.usuario, email };
}

// Promove direto no banco, como o administrador faria no Atlas
async function cadastrarAdmin(nome) {
  const conta = await cadastrar(nome);
  await Usuario.updateOne({ email: conta.email }, { $set: { role: 'admin' } });
  return conta;
}

function enviarPrivado(token, mensagem) {
  const form = new FormData();
  form.append('mensagem', mensagem);
  return api('/api/chat', { metodo: 'POST', token, form });
}

function cliente(token, auth = {}) {
  const socket = conectar(base, { auth: { token, ...auth }, transports: ['websocket'], reconnection: false, forceNew: true });
  socket.gastos = [];
  socket.recebidas = [];
  socket.online = [];
  socket.on('novoGastoDeToken', (quantidade, detalhes) => socket.gastos.push({ quantidade, detalhes }));
  socket.on('mensagemRecebida', (m) => socket.recebidas.push(m));
  socket.on('usuariosOnline', (o) => socket.online.push(o));
  abertos.push(socket);
  return socket;
}

function conectado(socket) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

async function esperar(condicao, ms = 3000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condicao nao satisfeita a tempo');
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const novoId = () => `admin-${Date.now()}-${++seq}`;

// ---------- Ciclo de vida ----------
before(async () => {
  await iniciar(0);
  base = `http://127.0.0.1:${servidor.address().port}`;
  await mongoose.connection.db.dropDatabase();
  await Mensagem.syncIndexes();
});

beforeEach(async () => {
  while (abertos.length) abertos.pop().disconnect();
  await pausa(50);
  chamadasGemini.length = 0;
  respostasGemini.length = 0;
});

after(async () => {
  while (abertos.length) abertos.pop().disconnect();
  io.close();
  await new Promise((r) => servidor.close(r));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

// ---------- RBAC ----------
test('REQ-001: novo usuario nasce "user" e nao consegue se cadastrar como admin', async () => {
  const comum = await cadastrar('Comum');
  assert.equal(comum.usuario.role, 'user');

  const espertinho = await cadastrar('Espertinho', { role: 'admin' });
  assert.equal(espertinho.usuario.role, 'user', 'role enviado no cadastro e ignorado');
  const noBanco = await Usuario.findOne({ email: espertinho.email }).lean();
  assert.equal(noBanco.role, 'user');

  // Usuarios antigos, sem o campo role, continuam "user" (sem migracao destrutiva)
  await Usuario.collection.insertOne({ nome: 'Antigo', email: `antigo-${Date.now()}@teste.com`, senhaHash: 'x' });
  const antigo = await Usuario.findOne({ nome: 'Antigo' });
  assert.equal(antigo.role, 'user');
});

test('REQ-002/006: /api/analytics/tokens -> 401 sem token, 403 para user, 200 para admin', async () => {
  const semToken = await api('/api/analytics/tokens');
  assert.equal(semToken.status, 401);

  const tokenInvalido = await api('/api/analytics/tokens', { token: 'abc.def.ghi' });
  assert.equal(tokenInvalido.status, 401);

  const comum = await cadastrar('Comum');
  const negado = await api('/api/analytics/tokens', { token: comum.token });
  assert.equal(negado.status, 403);
  assert.equal(negado.dados.totalTokens, undefined, 'nenhum dado administrativo no 403');

  const admin = await cadastrarAdmin('Chefe');
  const ok = await api('/api/analytics/tokens', { token: admin.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.dados));
  for (const campo of ['totalTokens', 'totalMensagens', 'totalUsuarios', 'tokensPorDia', 'mensagensPorDia']) {
    assert.ok(campo in ok.dados, `falta ${campo}`);
  }

  // O role vem do banco: rebaixado, perde o acesso na hora (mesmo com o mesmo JWT)
  await Usuario.updateOne({ email: admin.email }, { $set: { role: 'user' } });
  const rebaixado = await api('/api/analytics/tokens', { token: admin.token });
  assert.equal(rebaixado.status, 403);
});

test('usuario comum nao consegue virar admin por nenhuma rota da API', async () => {
  const comum = await cadastrar('Comum');
  const tentativas = [
    ['PUT', '/api/auth/me'],
    ['PATCH', '/api/auth/me'],
    ['POST', '/api/auth/me'],
    ['PUT', '/api/usuarios/me'],
    ['PATCH', '/api/analytics/tokens'],
  ];
  for (const [metodo, rota] of tentativas) {
    const r = await api(rota, { metodo, token: comum.token, corpo: { role: 'admin' } });
    assert.ok([404, 405].includes(r.status), `${metodo} ${rota} -> ${r.status}`);
  }
  // Login com "role" no corpo tambem nao muda nada
  await api('/api/auth/login', { metodo: 'POST', corpo: { email: comum.email, senha: 'senha123', role: 'admin' } });
  assert.equal((await Usuario.findOne({ email: comum.email }).lean()).role, 'user');
  assert.equal((await api('/api/analytics/tokens', { token: comum.token })).status, 403);
});

// ---------- Tokens ----------
test('REQ-004: extrairTokensGastos le result.response.usageMetadata e ignora dados invalidos', () => {
  const ok = extrairTokensGastos({
    modelo: 'gemini-teste',
    response: { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 } },
  });
  assert.deepEqual(ok, { tokensGastos: 125, tokensEntrada: 100, tokensSaida: 25, modeloIA: 'gemini-teste' });

  for (const invalido of [null, {}, { response: {} }, { response: { usageMetadata: null } },
    { response: { usageMetadata: { totalTokenCount: -3 } } }, { response: { usageMetadata: { totalTokenCount: 'muito' } } },
    { response: { usageMetadata: { totalTokenCount: 1.5 } } }, { response: { usageMetadata: { totalTokenCount: 0 } } }]) {
    assert.equal(extrairTokensGastos(invalido), null, JSON.stringify(invalido));
  }
});

test('REQ-003/004: chat privado grava tokensGastos na resposta da IA (e nao na pergunta)', async () => {
  const ana = await cadastrar('Ana');
  respostasGemini.push({ texto: 'Ola Ana!', uso: { promptTokenCount: 200, candidatesTokenCount: 40, totalTokenCount: 240 } });
  const r = await enviarPrivado(ana.token, 'oi');
  assert.equal(r.status, 200);
  // Consumo e administrativo: nao vai para o usuario
  assert.equal(r.dados.resposta.tokensGastos, undefined);

  const pergunta = await Mensagem.findById(r.dados.pergunta._id).lean();
  const resposta = await Mensagem.findById(r.dados.resposta._id).lean();
  assert.equal(pergunta.tokensGastos, 0);
  assert.equal(resposta.tokensGastos, 240);
  assert.equal(resposta.tokensEntrada, 200);
  assert.equal(resposta.tokensSaida, 40);
  assert.ok(resposta.modeloIA);

  const historico = await api('/api/chat/historico', { token: ana.token });
  assert.ok(historico.dados.mensagens.every((m) => m.tokensGastos === undefined));
});

test('function calling (clima): soma o consumo real das duas chamadas ao Gemini', async () => {
  const ana = await cadastrar('Ana');
  respostasGemini.push(
    { funcao: { name: 'consultar_clima', args: { cidade: 'Toquio' } }, uso: { promptTokenCount: 90, candidatesTokenCount: 10, totalTokenCount: 100 } },
    { texto: 'Faz 20 graus em Toquio.', uso: { promptTokenCount: 140, candidatesTokenCount: 20, totalTokenCount: 160 } }
  );
  const r = await enviarPrivado(ana.token, 'Qual a temperatura em Toquio?');
  assert.equal(r.status, 200);
  assert.equal(chamadasGemini.length, 2);
  const resposta = await Mensagem.findById(r.dados.resposta._id).lean();
  assert.equal(resposta.tokensGastos, 260);
  assert.equal(resposta.tokensEntrada, 230);
  assert.equal(resposta.tokensSaida, 30);
  assert.equal(resposta.ferramentaUsada, 'consultar_clima');
});

test('sem usageMetadata o chat continua e nada e inventado (tokensGastos = 0, sem evento)', async () => {
  const admin = await cadastrarAdmin('Chefe');
  const painel = await conectado(cliente(admin.token, { painel: 'admin' }));
  assert.equal((await painel.timeout(3000).emitWithAck('entrarPainelAdmin')).ok, true);

  const ana = await cadastrar('Ana');
  respostasGemini.push({ texto: 'Sem metadados.' });
  const r = await enviarPrivado(ana.token, 'oi');
  assert.equal(r.status, 200);
  assert.equal(r.dados.resposta.texto, 'Sem metadados.');
  assert.equal((await Mensagem.findById(r.dados.resposta._id).lean()).tokensGastos, 0);
  await pausa(200);
  assert.equal(painel.gastos.length, 0);
});

// ---------- Tempo real ----------
test('novoGastoDeToken: so administradores no painel recebem, uma vez por resposta', async () => {
  const admin = await cadastrarAdmin('Chefe');
  const comum = await cadastrar('Comum');

  const painel = await conectado(cliente(admin.token, { painel: 'admin' }));
  assert.deepEqual(await painel.timeout(3000).emitWithAck('entrarPainelAdmin'), { ok: true });

  // Usuario comum: nao entra na sala admin nem que peca
  const intruso = await conectado(cliente(comum.token, { painel: 'admin' }));
  const negado = await intruso.timeout(3000).emitWithAck('entrarPainelAdmin');
  assert.equal(negado.ok, false);
  assert.equal(negado.status, 403);
  const salaDoChat = await conectado(cliente(comum.token));

  // Mencao na sala publica e chat privado: cada um gera um evento com a quantidade real
  respostasGemini.push({ texto: 'Oi pessoal!', uso: { promptTokenCount: 300, candidatesTokenCount: 50, totalTokenCount: 350 } });
  const ack = await salaDoChat.timeout(5000).emitWithAck('novaMensagem', { texto: '@gemini oi', clientId: novoId() });
  assert.equal(ack.ok, true);
  await esperar(() => painel.gastos.length === 1);
  const evento = painel.gastos[0];
  assert.equal(evento.quantidade, 350);
  assert.equal(evento.detalhes.origem, 'sala');
  assert.match(evento.detalhes.dia, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(evento.detalhes.hora >= 0 && evento.detalhes.hora <= 23);
  const salva = await Mensagem.findById(evento.detalhes.mensagemId).lean();
  assert.equal(salva.tokensGastos, 350, 'o evento so sai depois de gravar no banco');

  // A resposta publica do bot nao expoe o consumo para a sala
  await esperar(() => salaDoChat.recebidas.some((m) => m.autor === 'model'));
  assert.equal(salaDoChat.recebidas.find((m) => m.autor === 'model').tokensGastos, undefined);

  respostasGemini.push({ texto: 'Privado.', uso: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
  await enviarPrivado(comum.token, 'oi');
  await esperar(() => painel.gastos.length === 2);
  assert.equal(painel.gastos[1].quantidade, 15);
  assert.equal(painel.gastos[1].detalhes.origem, 'chat-privado');

  await pausa(200);
  assert.equal(intruso.gastos.length, 0, 'usuario comum nunca recebe eventos administrativos');
  assert.equal(salaDoChat.gastos.length, 0);
  assert.equal(painel.gastos.length, 2, 'sem duplicacao');
});

test('painel nao conta como pessoa online e perde a sala admin quando o role e removido', async () => {
  const admin = await cadastrarAdmin('Chefe');
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  await esperar(() => sa.online.length > 0);
  const antes = sa.online.at(-1).total;

  const painel = await conectado(cliente(admin.token, { painel: 'admin' }));
  assert.equal((await painel.timeout(3000).emitWithAck('entrarPainelAdmin')).ok, true);
  await pausa(200);
  assert.equal(sa.online.at(-1).total, antes, 'o painel nao aparece no contador do chat');

  const negacoes = [];
  painel.on('painelAdminNegado', (d) => negacoes.push(d));
  await Usuario.updateOne({ email: admin.email }, { $set: { role: 'user' } });
  await io.revalidarSalaAdmins();
  await esperar(() => negacoes.length === 1);

  respostasGemini.push({ texto: 'x', uso: USO_PADRAO });
  await enviarPrivado(ana.token, 'oi');
  await pausa(200);
  assert.equal(painel.gastos.length, 0, 'admin rebaixado nao recebe mais eventos');
});

// ---------- Analytics ----------
test('REQ-005: totais, por dia, por hora e media batem com o que esta no banco', async () => {
  await Mensagem.deleteMany({});
  const admin = await cadastrarAdmin('Chefe');
  const dono = admin.usuario._id;
  const agora = Date.now();
  const hora = 3600 * 1000;
  await Mensagem.insertMany([
    { usuario: dono, autor: 'user', texto: 'a', createdAt: new Date(agora - 2 * hora) },
    { usuario: dono, autor: 'model', texto: 'b', tokensGastos: 100, tokensEntrada: 80, tokensSaida: 20, createdAt: new Date(agora - 2 * hora) },
    { usuario: dono, autor: 'model', texto: 'c', tokensGastos: 50, tokensEntrada: 40, tokensSaida: 10, createdAt: new Date(agora - 26 * hora) },
    { usuario: dono, autor: 'model', texto: 'sem metadados', tokensGastos: 0, createdAt: new Date(agora - 26 * hora) },
    { usuario: dono, autor: 'model', texto: 'antiga', tokensGastos: 1000, createdAt: new Date(agora - 40 * 24 * hora) },
  ]);

  const r = await api('/api/analytics/tokens?dias=7', { token: admin.token });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const d = r.dados;

  assert.equal(d.totalTokens, 1150);
  assert.equal(d.totalMensagens, 5);
  assert.equal(d.totalUsuarios, await Usuario.countDocuments());
  assert.equal(d.totalRespostasIA, 4);
  assert.equal(d.respostasComTokens, 3);
  assert.equal(d.mediaTokensPorResposta, 383.3); // 1150 / 3
  assert.equal(d.tokensEntrada, 120);
  assert.equal(d.tokensSaida, 30);
  assert.deepEqual(d.ultimos7Dias, { tokens: 150, mensagens: 4 });
  assert.deepEqual(d.ultimos30Dias, { tokens: 150, mensagens: 4 });

  // 7 dias completos (com zeros), sem a mensagem de 40 dias atras
  assert.equal(d.tokensPorDia.length, 7);
  assert.equal(d.mensagensPorDia.length, 7);
  const somaDias = d.tokensPorDia.map((x) => x.tokens).reduce((a, b) => a + b, 0);
  assert.equal(somaDias, 150);
  assert.equal(d.tokensPorDia.at(-1).tokensAcumulados, 150);
  assert.equal(d.mensagensPorDia.map((x) => x.mensagens).reduce((a, b) => a + b, 0), 4);
  assert.equal(d.periodo.fusoHorario, 'America/Sao_Paulo');

  assert.equal(d.porHora.length, 24);
  assert.equal(d.porHora.map((x) => x.mensagens).reduce((a, b) => a + b, 0), 4);
  // As mensagens de 2h e de 26h atras caem na mesma hora do dia (no fuso de Sao Paulo)
  const { horaNoFuso } = require('../config/fusoHorario');
  assert.deepEqual(d.horarioDePico, { hora: horaNoFuso(agora - 2 * hora), mensagens: 4 });

  // Periodo invalido cai no padrao (30 dias)
  const padrao = await api('/api/analytics/tokens?dias=999', { token: admin.token });
  assert.equal(padrao.dados.periodo.dias, 30);
});

// ---------- Auditoria estatica da rubrica ----------
test('rubrica: arquivos, nomes e trechos exigidos existem', () => {
  const raiz = path.join(__dirname, '..');
  const ler = (arquivo) => fs.readFileSync(path.join(raiz, arquivo), 'utf8');

  const usuario = ler('models/Usuario.js');
  assert.match(usuario, /role:\s*{\s*type:\s*String,\s*default:\s*"user"/);

  const apenasAdmin = ler('middlewares/apenasAdmin.js');
  assert.match(apenasAdmin, /req\.usuario\.role/);
  assert.match(apenasAdmin, /if\s*\(role === "admin"\)\s*{\s*return next\(\);\s*}\s*else\s*{\s*return res\.status\(403\)/);

  assert.match(ler('models/Mensagem.js'), /tokensGastos:\s*{\s*type:\s*Number,\s*default:\s*0/);
  assert.match(ler('controllers/chatController.js'), /result\.response\.usageMetadata\.totalTokenCount/);
  assert.match(ler('controllers/chatController.js'), /emit\("novoGastoDeToken", quantidade/);

  const analytics = ler('controllers/analyticsController.js');
  assert.match(analytics, /Mensagem\.aggregate\(/);
  assert.match(analytics, /\$group/);
  assert.match(analytics, /\$sum/);
  assert.doesNotMatch(analytics, /\.reduce\(|\.find\(|for \(/, 'sem somas em JavaScript');

  const rotas = ler('routes/analyticsRoutes.js');
  assert.match(rotas, /router\.get\(\s*"\/tokens",\s*autenticarToken,\s*apenasAdmin,\s*obterAnaliseDeTokens\s*\)/);
  assert.match(ler('server.js'), /app\.use\('\/api\/analytics', analyticsRoutes\)/);

  const dashboard = ler('../frontend/dashboard.html');
  assert.ok(dashboard.includes('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>'));
  assert.ok(dashboard.includes('<canvas id="graficoTokens"></canvas>'));
});

test('fuso do analytics: sem ANALYTICS_TIMEZONE (ou com valor invalido) usa America/Sao_Paulo', () => {
  const { execFileSync } = require('node:child_process');
  const ler = (valor) => {
    const env = { ...process.env };
    if (valor === undefined) delete env.ANALYTICS_TIMEZONE;
    else env.ANALYTICS_TIMEZONE = valor;
    return execFileSync(process.execPath, ['-e', "process.stdout.write(require('./config/fusoHorario').FUSO_ANALYTICS)"], {
      cwd: path.join(__dirname, '..'),
      env,
    }).toString();
  };
  assert.equal(ler(undefined), 'America/Sao_Paulo');
  assert.equal(ler(''), 'America/Sao_Paulo');
  assert.equal(ler('Fuso/Inexistente'), 'America/Sao_Paulo');
  assert.equal(ler('Europe/Lisbon'), 'Europe/Lisbon');
});
