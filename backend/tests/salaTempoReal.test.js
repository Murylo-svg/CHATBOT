/**
 * Testes de integracao da sala publica em tempo real (Sprint 7).
 *
 * Sobem o servidor de verdade (Express + Socket.io no mesmo HTTP) contra um
 * MongoDB de teste e conectam clientes Socket.io reais.
 * Gemini e Cloudinary sao simulados para nao gastar cota nem precisar de chave.
 *
 * Uso:  MONGO_URI_TESTE="mongodb://127.0.0.1:27017/chatbot-teste" npm test
 *       (ou defina MONGO_URI_TESTE no backend/.env)
 * ATENCAO: o banco de teste e APAGADO a cada execucao. Nunca use o banco de producao.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();
const MONGO_URI_TESTE = process.env.MONGO_URI_TESTE;
if (!MONGO_URI_TESTE) {
  test('integracao da sala publica', { skip: 'defina MONGO_URI_TESTE para rodar' }, () => {});
  return;
}

process.env.MONGO_URI = MONGO_URI_TESTE;
process.env.JWT_SECRET = 'segredo-de-teste-' + Date.now();
process.env.GEMINI_API_KEY = 'chave-falsa';
process.env.CORS_ORIGIN = 'https://meu-app.vercel.app';

// ---------- Simulacoes (antes de carregar o servidor) ----------
const cloudinary = require('../services/cloudinary');
const uploads = [];
cloudinary.enviarImagem = async (buffer, usuarioId) => {
  uploads.push({ tamanho: buffer.length, usuarioId });
  return `https://res.cloudinary.com/teste/image/upload/${usuarioId}/${uploads.length}.png`;
};

const chamadasGemini = [];
let respostaGemini = 'Ola! Eu sou o moderador.';
const fetchOriginal = global.fetch;
global.fetch = async (url, opcoes) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    chamadasGemini.push(JSON.parse(opcoes.body));
    await new Promise((r) => setTimeout(r, 30));
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: respostaGemini }] } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return fetchOriginal(url, opcoes);
};

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io: conectar } = require('socket.io-client');
const { servidor, io, iniciar } = require('../server');
const Mensagem = require('../models/Message');

let base;
const abertos = [];

// ---------- Utilitarios ----------
async function api(caminho, { metodo = 'GET', token, corpo, origem } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (corpo) headers['Content-Type'] = 'application/json';
  if (origem) headers.Origin = origem;
  const r = await fetchOriginal(base + caminho, {
    method: metodo,
    headers,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    /* sem corpo */
  }
  return { status: r.status, dados, headers: r.headers };
}

async function cadastrar(nome) {
  const email = `${nome.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@teste.com`;
  const r = await api('/api/auth/register', { metodo: 'POST', corpo: { nome, email, senha: 'senha123' } });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return { token: r.dados.token, usuario: r.dados.usuario, email };
}

function cliente(token, extra = {}) {
  const socket = conectar(base, {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    ...extra,
  });
  socket.recebidas = [];
  socket.online = [];
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

function recusado(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => reject(new Error('conexao deveria ter sido recusada')));
    socket.once('connect_error', resolve);
  });
}

function emitir(socket, dados) {
  return socket.timeout(5000).emitWithAck('novaMensagem', dados);
}

async function esperar(condicao, ms = 3000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (condicao()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condicao nao satisfeita a tempo');
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const novoId = () => `teste-${Date.now()}-${++seq}`;

// PNG valido de 1x1
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

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
  respostaGemini = 'Ola! Eu sou o moderador.';
});

after(async () => {
  while (abertos.length) abertos.pop().disconnect();
  io.close();
  await new Promise((r) => servidor.close(r));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

// ---------- 1. Tempo real entre duas sessoes ----------
test('mensagem enviada por uma sessao aparece na outra imediatamente, com o nome do banco', async () => {
  const ana = await cadastrar('Ana');
  const beto = await cadastrar('Beto');
  const sa = await conectado(cliente(ana.token));
  const sb = await conectado(cliente(beto.token));

  const clientId = novoId();
  // Tenta falsificar a identidade: o servidor deve ignorar tudo isso
  const ack = await emitir(sa, { texto: 'Oi, Beto!', clientId, nome: 'Admin', nomeAutor: 'Admin', usuario: beto.usuario._id });
  assert.equal(ack.ok, true);

  await esperar(() => sb.recebidas.some((m) => m.clientId === clientId));
  const recebida = sb.recebidas.find((m) => m.clientId === clientId);
  assert.equal(recebida.texto, 'Oi, Beto!');
  assert.equal(recebida.nomeAutor, 'Ana');
  assert.equal(recebida.usuario, ana.usuario._id);
  assert.equal(recebida.autor, 'user');

  const salva = await Mensagem.findById(recebida._id).lean();
  assert.equal(salva.sala, 'publica');
  assert.equal(salva.nomeAutor, 'Ana');
  assert.equal(String(salva.usuario), ana.usuario._id);
});

// ---------- 2. Mensagem comum nao aciona o Gemini ----------
test('mensagens normais nao acionam o Gemini', async () => {
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  for (const texto of ['bom dia', 'meu email e ana@gemini.com', 'aperte o @botao', 'gemini e bot sem arroba']) {
    const ack = await emitir(sa, { texto, clientId: novoId() });
    assert.equal(ack.ok, true, texto);
  }
  await pausa(200);
  assert.equal(chamadasGemini.length, 0);
});

// ---------- 3. @gemini / @bot: resposta para todos ----------
test('@gemini e @bot geram UMA resposta do Moderador Gemini, vista por todos', async () => {
  const ana = await cadastrar('Ana');
  const beto = await cadastrar('Beto');
  const sa = await conectado(cliente(ana.token));
  const sb = await conectado(cliente(beto.token));

  const digitando = [];
  sb.on('moderadorDigitando', (d) => digitando.push(d.ativo));

  // O bot "responde" com uma mencao: nao pode gerar loop
  respostaGemini = 'Oi Ana! Pode me chamar com @bot quando quiser.';
  const ack = await emitir(sa, { texto: '@gemini qual a capital da Franca?', clientId: novoId() });
  assert.equal(ack.ok, true);

  const ehBot = (m) => m.autor === 'model';
  await esperar(() => sa.recebidas.some(ehBot) && sb.recebidas.some(ehBot));
  const resposta = sb.recebidas.find(ehBot);
  assert.equal(resposta.nomeAutor, '🤖 Moderador Gemini');
  assert.equal(resposta.respostaA, ack.mensagem._id);
  assert.equal(resposta.texto, respostaGemini);
  assert.deepEqual(digitando, [true, false]);

  await pausa(300);
  assert.equal(chamadasGemini.length, 1, 'Gemini chamado exatamente uma vez (sem loop)');
  assert.equal(sb.recebidas.filter(ehBot).length, 1);

  // A pergunta chega com o nome de quem perguntou e a persona do moderador
  const corpo = chamadasGemini[0];
  const ultima = corpo.contents[corpo.contents.length - 1];
  assert.match(ultima.parts.at(-1).text, /^Ana: @gemini qual a capital/);
  assert.match(corpo.systemInstruction.parts[0].text, /Moderador Gemini/);

  // @bot tambem funciona, e o historico (memoria) inclui a conversa anterior com nomes
  await emitir(sb, { texto: 'Valeu! @BOT, o que a Ana perguntou?', clientId: novoId() });
  await esperar(() => chamadasGemini.length === 2);
  const contexto = JSON.stringify(chamadasGemini[1].contents);
  assert.match(contexto, /Ana: @gemini qual a capital da Franca/);
  assert.match(contexto, /Beto: Valeu! @BOT/);
});

// ---------- 4. JWT invalido, ausente ou expirado ----------
test('conexoes com JWT invalido, ausente, expirado ou de usuario inexistente sao recusadas', async () => {
  const semToken = await recusado(cliente(undefined));
  assert.equal(semToken.data.codigo, 'TOKEN_INVALIDO');

  const lixo = await recusado(cliente('isso.nao.e.um.jwt'));
  assert.equal(lixo.data.codigo, 'TOKEN_INVALIDO');

  const outroSegredo = jwt.sign({ id: new mongoose.Types.ObjectId().toString(), nome: 'Hacker' }, 'outro-segredo');
  const assinadoErrado = await recusado(cliente(outroSegredo));
  assert.equal(assinadoErrado.data.codigo, 'TOKEN_INVALIDO');

  const expirado = jwt.sign({ id: new mongoose.Types.ObjectId().toString(), nome: 'X' }, process.env.JWT_SECRET, { expiresIn: -10 });
  const exp = await recusado(cliente(expirado));
  assert.equal(exp.data.codigo, 'TOKEN_EXPIRADO');

  const fantasma = jwt.sign({ id: new mongoose.Types.ObjectId().toString(), nome: 'Fantasma' }, process.env.JWT_SECRET);
  const inexistente = await recusado(cliente(fantasma));
  assert.equal(inexistente.data.codigo, 'USUARIO_INEXISTENTE');
});

// ---------- 5. Nome exibido = usuario autenticado, mesmo com nome adulterado no token ----------
test('o nome exibido vem do MongoDB, nao do cliente nem do payload do token', async () => {
  const ana = await cadastrar('Ana');
  // Token valido para Ana, mas com outro "nome" no payload
  const tokenComNomeFalso = jwt.sign({ id: ana.usuario._id, nome: 'Presidente' }, process.env.JWT_SECRET);
  const sa = await conectado(cliente(tokenComNomeFalso));
  const ack = await emitir(sa, { texto: 'quem sou eu?', clientId: novoId(), nomeAutor: 'Presidente' });
  assert.equal(ack.mensagem.nomeAutor, 'Ana');
});

// ---------- 6. Contador de usuarios online ----------
test('contador de online acompanha conexoes e desconexoes sem contar em dobro', async () => {
  await pausa(100);
  const ana = await cadastrar('Ana');
  const beto = await cadastrar('Beto');
  const observador = await cadastrar('Obs');
  const so = await conectado(cliente(observador.token));
  await esperar(() => so.online.length > 0);
  const inicial = so.online.at(-1).total;

  const sa = await conectado(cliente(ana.token));
  await esperar(() => so.online.at(-1).total === inicial + 1);

  const sb = await conectado(cliente(beto.token));
  await esperar(() => so.online.at(-1).total === inicial + 2);

  // Segunda aba da Ana: mesmo usuario, nao aumenta o total de usuarios
  const sa2 = await conectado(cliente(ana.token));
  await esperar(() => so.online.at(-1).conexoes === inicial + 3);
  assert.equal(so.online.at(-1).total, inicial + 2);
  assert.ok(so.online.at(-1).nomes.includes('Ana'));

  sb.disconnect();
  await esperar(() => so.online.at(-1).total === inicial + 1);

  sa.disconnect();
  await pausa(100);
  assert.equal(so.online.at(-1).total, inicial + 1, 'Ana ainda tem uma aba aberta');

  sa2.disconnect();
  await esperar(() => so.online.at(-1).total === inicial);
});

// ---------- 7. Reenvio apos reconexao nao duplica ----------
test('reenviar o mesmo clientId nao duplica no banco, na tela nem no Gemini', async () => {
  const ana = await cadastrar('Ana');
  const beto = await cadastrar('Beto');
  const sa = await conectado(cliente(ana.token));
  const sb = await conectado(cliente(beto.token));
  const clientId = novoId();

  const primeiro = await emitir(sa, { texto: '@bot me responda uma vez so', clientId });
  assert.equal(primeiro.ok, true);
  assert.equal(primeiro.duplicada, false);

  // Simula queda e reconexao com reenvio da mesma mensagem
  sa.disconnect();
  const sa2 = await conectado(cliente(ana.token));
  const segundo = await emitir(sa2, { texto: '@bot me responda uma vez so', clientId });
  assert.equal(segundo.ok, true);
  assert.equal(segundo.duplicada, true);
  assert.equal(segundo.mensagem._id, primeiro.mensagem._id);

  await esperar(() => sb.recebidas.some((m) => m.autor === 'model'));
  await pausa(200);
  assert.equal(await Mensagem.countDocuments({ clientId }), 1);
  assert.equal(sb.recebidas.filter((m) => m.clientId === clientId).length, 1);
  assert.equal(chamadasGemini.length, 1);
});

test('dois envios simultaneos do mesmo clientId gravam uma unica mensagem', async () => {
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  const clientId = novoId();
  const [r1, r2] = await Promise.all([
    emitir(sa, { texto: 'em paralelo', clientId }),
    emitir(sa, { texto: 'em paralelo', clientId }),
  ]);
  assert.ok(r1.ok || r2.ok);
  assert.equal(await Mensagem.countDocuments({ clientId }), 1);
  await pausa(100);
  assert.equal(sa.recebidas.filter((m) => m.clientId === clientId).length, 1);
});

// ---------- 8. Validacoes de conteudo ----------
test('mensagens vazias, grandes demais ou com imagem falsa sao recusadas', async () => {
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));

  for (const texto of ['', '   ', '\n\n', '​​']) {
    const r = await emitir(sa, { texto, clientId: novoId() });
    assert.equal(r.ok, false, JSON.stringify(texto));
    assert.match(r.erro, /vazia/);
  }

  const grande = await emitir(sa, { texto: 'a'.repeat(2001), clientId: novoId() });
  assert.equal(grande.ok, false);
  assert.match(grande.erro, /2000/);

  const tipoErrado = await emitir(sa, { texto: { $gt: '' }, clientId: novoId() });
  assert.equal(tipoErrado.ok, false);

  const idRuim = await emitir(sa, { texto: 'oi', clientId: '../../x' });
  assert.equal(idRuim.ok, false);

  const naoImagem = await emitir(sa, { texto: 'veja', clientId: novoId(), imagem: { dados: Buffer.from('<script>alert(1)</script>') } });
  assert.equal(naoImagem.ok, false);
  assert.match(naoImagem.erro, /Formato de imagem/);

  assert.equal(await Mensagem.countDocuments({ usuario: ana.usuario._id }), 0);
});

test('limite de envio por usuario bloqueia flood', async () => {
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  const respostas = [];
  for (let i = 0; i < 10; i++) respostas.push(await emitir(sa, { texto: 'flood ' + i, clientId: novoId() }));
  assert.equal(respostas.filter((r) => r.ok).length, 8);
  assert.match(respostas.at(-1).erro, /rapido demais/);
});

// ---------- 9. Imagem pelo socket ----------
test('imagem enviada pela sala vai para o Cloudinary e para o Gemini quando ha mencao', async () => {
  const ana = await cadastrar('Ana');
  const beto = await cadastrar('Beto');
  const sa = await conectado(cliente(ana.token));
  const sb = await conectado(cliente(beto.token));

  const ack = await emitir(sa, { texto: '@gemini qual a cor?', clientId: novoId(), imagem: { dados: PNG } });
  assert.equal(ack.ok, true);
  assert.match(ack.mensagem.imagemUrl, /^https:\/\/res\.cloudinary\.com\//);
  assert.equal(uploads.at(-1).usuarioId, ana.usuario._id);

  await esperar(() => sb.recebidas.some((m) => m.autor === 'model'));
  const partes = chamadasGemini[0].contents.at(-1).parts;
  assert.equal(partes[0].inlineData.mimeType, 'image/png');
  assert.equal(partes[0].inlineData.data, PNG.toString('base64'));
});

// ---------- 10. REST: historico, CORS, rotas antigas e limpeza ----------
test('historico REST da sala usa o mesmo formato e os mesmos _id do WebSocket', async () => {
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  const ack = await emitir(sa, { texto: 'mensagem para o historico', clientId: novoId() });

  const semToken = await api('/api/chat/sala');
  assert.equal(semToken.status, 401);

  const r = await api('/api/chat/sala', { token: ana.token });
  assert.equal(r.status, 200);
  const doHistorico = r.dados.mensagens.find((m) => m._id === ack.mensagem._id);
  assert.deepEqual(doHistorico, JSON.parse(JSON.stringify(ack.mensagem)));
  // Ordem cronologica
  const datas = r.dados.mensagens.map((m) => new Date(m.createdAt).getTime());
  assert.deepEqual(datas, [...datas].sort((a, b) => a - b));
});

test('rotas REST existentes continuam funcionando (login, me, chat privado, health)', async () => {
  const ana = await cadastrar('Ana');

  const login = await api('/api/auth/login', { metodo: 'POST', corpo: { email: ana.email, senha: 'senha123' } });
  assert.equal(login.status, 200);
  const senhaErrada = await api('/api/auth/login', { metodo: 'POST', corpo: { email: ana.email, senha: 'errada1' } });
  assert.equal(senhaErrada.status, 401);

  const me = await api('/api/auth/me', { token: login.dados.token });
  assert.equal(me.dados.usuario.nome, 'Ana');
  assert.equal(me.dados.usuario.senhaHash, undefined);

  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.dados.status, 'ok');

  // Mensagem na sala publica nao pode vazar para o chat privado (e vice-versa)
  const sa = await conectado(cliente(ana.token));
  await emitir(sa, { texto: 'publica', clientId: novoId() });

  const form = new FormData();
  form.append('mensagem', 'privada');
  const privada = await fetchOriginal(base + '/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ana.token },
    body: form,
  });
  assert.equal(privada.status, 200);

  const historico = await api('/api/chat/historico', { token: ana.token });
  const textos = historico.dados.mensagens.map((m) => m.texto);
  assert.ok(textos.includes('privada'));
  assert.ok(!textos.includes('publica'));

  const sala = await api('/api/chat/sala', { token: ana.token });
  assert.ok(!sala.dados.mensagens.some((m) => m.texto === 'privada'));
});

test('CORS: Vercel e localhost liberados; origem desconhecida bloqueada no REST e no Socket.io', async () => {
  const ok = await api('/api/health', { origem: 'https://meu-app.vercel.app' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://meu-app.vercel.app');

  const local = await api('/api/health', { origem: 'http://localhost:5500' });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5500');

  const ruim = await api('/api/health', { origem: 'https://site-malicioso.com' });
  assert.equal(ruim.status, 403);

  const ana = await cadastrar('Ana');
  const bloqueado = cliente(ana.token, { extraHeaders: { Origin: 'https://site-malicioso.com' } });
  await recusado(bloqueado);

  const liberado = cliente(ana.token, { extraHeaders: { Origin: 'https://meu-app.vercel.app' } });
  await conectado(liberado);
});

test('limpar historico apaga as mensagens da pessoa e as respostas do bot, avisando a sala', async () => {
  const ana = await cadastrar('Ana');
  const beto = await cadastrar('Beto');
  const sa = await conectado(cliente(ana.token));
  const sb = await conectado(cliente(beto.token));

  const removidas = [];
  sb.on('mensagensRemovidas', (d) => removidas.push(...d.ids));

  const daAna = await emitir(sa, { texto: '@bot oi', clientId: novoId() });
  const doBeto = await emitir(sb, { texto: 'oi Ana', clientId: novoId() });
  await esperar(() => sb.recebidas.some((m) => m.autor === 'model' && m.respostaA === daAna.mensagem._id));
  const doBot = sb.recebidas.find((m) => m.respostaA === daAna.mensagem._id);

  const r = await api('/api/chat/historico', { metodo: 'DELETE', token: ana.token });
  assert.equal(r.status, 200);
  assert.equal(r.dados.removidasDaSala, 2);

  await esperar(() => removidas.length === 2);
  assert.deepEqual(removidas.sort(), [daAna.mensagem._id, doBot._id].sort());

  const sala = await api('/api/chat/sala', { token: beto.token });
  const ids = sala.dados.mensagens.map((m) => m._id);
  assert.ok(!ids.includes(daAna.mensagem._id));
  assert.ok(!ids.includes(doBot._id));
  assert.ok(ids.includes(doBeto.mensagem._id), 'mensagens de outras pessoas ficam');
});
