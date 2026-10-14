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
process.env.MISTRAL_API_KEY = 'chave-mistral-falsa';
process.env.DEBATE_INTERVALO_MIN_SEGUNDOS = '0'; // testes rapidos
process.env.API_ESPERA_BASE_MS = '10';
process.env.DEBATE_ESPERA_ERRO_MS = '50';

// ---------- Simulacoes (antes de carregar o servidor) ----------
const cloudinary = require('../services/cloudinary');
const uploads = [];
cloudinary.enviarImagem = async (buffer, usuarioId) => {
  uploads.push({ tamanho: buffer.length, usuarioId });
  return `https://res.cloudinary.com/teste/image/upload/${usuarioId}/${uploads.length}.png`;
};

const chamadasGemini = [];
const urlsGemini = [];
const falhasGemini = []; // respostas de erro a devolver antes das proximas respostas normais
let respostaGemini = 'Ola! Eu sou o moderador.';
const fetchOriginal = global.fetch;
global.fetch = async (url, opcoes) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    chamadasGemini.push(JSON.parse(opcoes.body));
    urlsGemini.push(String(url));
    const falha = falhasGemini.shift();
    if (falha) {
      return new Response(JSON.stringify({ error: { code: falha.status, message: falha.mensagem } }), {
        status: falha.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    await new Promise((r) => setTimeout(r, 30));
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: respostaGemini }] } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (String(url).endsWith('api.mistral.ai/v1/models')) {
    consultasModelosMistral += 1;
    return new Response(
      JSON.stringify({
        data: [
          { id: 'mistral-embed', capabilities: { completion_chat: false } },
          { id: 'mistral-moderation-latest', capabilities: { completion_chat: false } },
          { id: 'codestral-latest', capabilities: { completion_chat: true } },
          { id: 'mistral-small-2599', capabilities: { completion_chat: true } },
          { id: 'mistral-large-latest', capabilities: { completion_chat: true } },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (String(url).includes('api.mistral.ai')) {
    const corpo = JSON.parse(opcoes.body);
    chamadasMistral.push({ corpo, headers: opcoes.headers });
    if (modelosMistralAposentados.has(corpo.model)) {
      return new Response(
        JSON.stringify({ object: 'error', message: `Invalid model: ${corpo.model}`, type: 'invalid_model', code: '1500' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    await new Promise((r) => setTimeout(r, 30));
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: `Mistral: discordo, fala ${chamadasMistral.length}. @gemini` } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return fetchOriginal(url, opcoes);
};
const chamadasMistral = [];
const modelosMistralAposentados = new Set();
let consultasModelosMistral = 0;

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
  urlsGemini.length = 0;
  chamadasMistral.length = 0;
  falhasGemini.length = 0;
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

// ---------- Debate entre IAs (Gemini x Mistral) ----------
function esperarFimDebate(socket, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('debate nao terminou')), ms);
    socket.on('debateEstado', (e) => {
      if (!e.ativo) {
        clearTimeout(timer);
        resolve(e);
      }
    });
  });
}

test('@debate coloca Gemini e Mistral para conversar em turnos, com intervalo, visivel para todos', async () => {
  const ana = await cadastrar('Ana');
  const beto = await cadastrar('Beto');
  const sa = await conectado(cliente(ana.token));
  const sb = await conectado(cliente(beto.token));
  const estados = [];
  sb.on('debateEstado', (e) => estados.push(e));
  const chegada = [];
  sb.on('mensagemRecebida', (m) => m.debate && chegada.push(Date.now()));
  const fim = esperarFimDebate(sb);

  respostaGemini = 'Gemini: concordo totalmente! @bot';
  const ack = await emitir(sa, { texto: '@debate cachorro ou gato?', clientId: novoId(), debate: { turnos: 4, intervalo: 0.3 } });
  assert.equal(ack.ok, true, ack.erro);

  const final = await fim;
  assert.match(final.motivo, /Fim do debate/);

  const falas = sb.recebidas.filter((m) => m.debate === ack.mensagem._id);
  assert.deepEqual(falas.map((m) => m.bot), ['gemini', 'mistral', 'gemini', 'mistral']);
  assert.deepEqual([...new Set(falas.map((m) => m.nomeAutor))], ['🤖 Moderador Gemini', '🌀 Mistral']);
  // O prefixo "Nome:" e as mencoes com @ sao removidos (evita loop e poluicao)
  assert.ok(falas.every((m) => !/^(gemini|mistral):/i.test(m.texto) && !m.texto.includes('@')), JSON.stringify(falas.map((m) => m.texto)));
  assert.equal(sa.recebidas.filter((m) => m.debate === ack.mensagem._id).length, 4, 'Ana tambem viu tudo');

  // Ritmo: entre uma fala e outra passa pelo menos o intervalo escolhido
  for (let i = 1; i < chegada.length; i++) assert.ok(chegada[i] - chegada[i - 1] >= 250, `intervalo ${chegada[i] - chegada[i - 1]}ms`);
  assert.ok(estados.some((e) => e.ativo && e.tema === 'cachorro ou gato?' && e.total === 4 && e.nomeFalando));

  // Cada IA chamada 2 vezes; as falas do Gemini nao geram respostas extras (@bot foi limpo)
  assert.equal(chamadasGemini.length, 2);
  assert.equal(chamadasMistral.length, 2);

  // O Mistral recebe a fala do Gemini como 'user' e a instrucao do debate como 'system'
  const msgsMistral = chamadasMistral[1].corpo.messages;
  assert.equal(msgsMistral[0].role, 'system');
  assert.match(msgsMistral[0].content, /Voce e Mistral/);
  assert.ok(msgsMistral.some((m) => m.role === 'assistant'));
  assert.equal(msgsMistral.at(-1).role, 'user');
  assert.match(msgsMistral.at(-1).content, /^Gemini: /);
  assert.equal(chamadasMistral[0].headers.Authorization, 'Bearer chave-mistral-falsa');
  assert.equal(chamadasMistral[0].corpo.model, 'mistral-small-latest');

  // O Gemini recebe a fala do Mistral como 'user' e as proprias como 'model'
  const contentsGemini = chamadasGemini[1].contents;
  assert.deepEqual(contentsGemini.map((c) => c.role), ['user', 'model', 'user']);
  assert.match(contentsGemini.at(-1).parts[0].text, /^Mistral: /);

  const salvas = await Mensagem.countDocuments({ debate: ack.mensagem._id });
  assert.equal(salvas, 4);
});

test('debate: um por vez, @parar e o botao encerram, e sem GEMINI_API_KEY ele nao comeca', async () => {
  const ana = await cadastrar('Ana');
  const beto = await cadastrar('Beto');
  const sa = await conectado(cliente(ana.token));
  const sb = await conectado(cliente(beto.token));

  const primeiro = await emitir(sa, { texto: '@debate praia ou montanha', clientId: novoId(), debate: { turnos: 20, intervalo: 0.4 } });
  assert.equal(primeiro.ok, true);

  const segundo = await emitir(sb, { texto: '@debate outro tema', clientId: novoId() });
  assert.equal(segundo.ok, false);
  assert.match(segundo.erro, /Ja existe um debate/);

  await esperar(() => sb.recebidas.some((m) => m.debate === primeiro.mensagem._id));
  const fim = esperarFimDebate(sa);
  const parar = await emitir(sb, { texto: '@parar', clientId: novoId() });
  assert.equal(parar.ok, true);
  const estado = await fim;
  assert.match(estado.motivo, /Beto parou o debate/);

  const quantas = sb.recebidas.filter((m) => m.debate).length;
  await pausa(1000);
  assert.equal(sb.recebidas.filter((m) => m.debate).length, quantas, 'nenhuma fala depois de parar');

  // Botao "Parar" (evento pararDebate)
  const terceiro = await emitir(sb, { texto: '@debate cafe ou cha', clientId: novoId(), debate: { turnos: 20, intervalo: 0.4 } });
  assert.equal(terceiro.ok, true);
  const fim2 = esperarFimDebate(sa);
  const ackParar = await sa.timeout(3000).emitWithAck('pararDebate');
  assert.equal(ackParar.ok, true);
  assert.match((await fim2).motivo, /Ana parou o debate/);
  assert.equal((await sa.timeout(3000).emitWithAck('pararDebate')).ok, false);

  // Sem chave do Gemini nao ha debate
  const chave = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = '';
  try {
    const semChave = await emitir(sa, { texto: '@debate sem chave', clientId: novoId() });
    assert.equal(semChave.ok, false);
    assert.match(semChave.erro, /GEMINI_API_KEY/);
  } finally {
    process.env.GEMINI_API_KEY = chave;
  }

  const semTema = await emitir(sa, { texto: '@debate', clientId: novoId() });
  assert.equal(semTema.ok, false);
  assert.match(semTema.erro, /tema/);
});

test('debate para sozinho quando todo mundo sai da sala', async () => {
  await pausa(100);
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  const ack = await emitir(sa, { texto: '@debate quem chegou primeiro, o ovo ou a galinha', clientId: novoId(), debate: { turnos: 20, intervalo: 0.3 } });
  assert.equal(ack.ok, true);
  await esperar(() => sa.recebidas.some((m) => m.debate));
  // fecha todas as conexoes abertas pelos testes
  while (abertos.length) abertos.pop().disconnect();
  await pausa(800);
  const total = await Mensagem.countDocuments({ debate: ack.mensagem._id });
  await pausa(800);
  assert.equal(await Mensagem.countDocuments({ debate: ack.mensagem._id }), total, 'parou de gerar falas');

  // e um novo debate ja pode comecar
  const sb = await conectado(cliente(ana.token));
  const novo = await emitir(sb, { texto: '@debate novo tema', clientId: novoId(), debate: { turnos: 2, intervalo: 0 } });
  assert.equal(novo.ok, true, novo.erro);
});

test('Gemini com "high demand" (503): tenta de novo e o debate continua', async () => {
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  const avisos = [];
  sa.on('debateEstado', (e) => e.aviso && avisos.push(e.aviso));
  const fim = esperarFimDebate(sa);

  // 4 falhas: 3 consumidas pelas tentativas rapidas da API + 1 que forca a espera extra do debate
  const alta = { status: 503, mensagem: 'This model is currently experiencing high demand. Please try again later.' };
  falhasGemini.push(alta, alta, alta, alta);

  const ack = await emitir(sa, { texto: '@debate sol ou chuva', clientId: novoId(), debate: { turnos: 2, intervalo: 0 } });
  assert.equal(ack.ok, true, ack.erro);
  const final = await fim;
  assert.match(final.motivo, /Fim do debate/);
  assert.deepEqual(sa.recebidas.filter((m) => m.debate).map((m) => m.bot), ['gemini', 'mistral']);
  assert.ok(avisos.some((a) => /sobrecarregado/.test(a)), 'a sala foi avisada da nova tentativa');
  assert.equal(chamadasGemini.length, 5);
});

test('@gemini tambem tenta de novo quando o modelo esta sobrecarregado', async () => {
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  falhasGemini.push({ status: 503, mensagem: 'high demand' }, { status: 429, mensagem: 'Resource exhausted' });
  await emitir(sa, { texto: '@gemini oi', clientId: novoId() });
  await esperar(() => sa.recebidas.some((m) => m.autor === 'model'));
  assert.equal(chamadasGemini.length, 3);
});

test('erro definitivo (ex.: chave invalida) interrompe o debate na hora, sem insistir', async () => {
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  const fim = esperarFimDebate(sa);
  falhasGemini.push({ status: 400, mensagem: 'API key not valid' });
  const ack = await emitir(sa, { texto: '@debate chave ruim', clientId: novoId(), debate: { turnos: 2, intervalo: 0 } });
  assert.equal(ack.ok, true);
  const final = await fim;
  assert.match(final.motivo, /Debate interrompido.*API key not valid/);
  assert.equal(chamadasGemini.length, 1);
});

test('sem MISTRAL_API_KEY o adversario e o Gemini 2, com chave e modelo proprios', async () => {
  const chaveMistral = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = '';
  process.env.GEMINI_API_KEY_2 = 'segunda-chave-gemini';
  process.env.GEMINI_MODEL_2 = 'gemini-modelo-dois';
  try {
    const ana = await cadastrar('Ana');
    const sa = await conectado(cliente(ana.token));
    const fim = esperarFimDebate(sa);
    respostaGemini = 'Gemini 2: discordo com ironia. @bot';
    const ack = await emitir(sa, { texto: '@debate gemini contra gemini', clientId: novoId(), debate: { turnos: 4, intervalo: 0 } });
    assert.equal(ack.ok, true, ack.erro);
    await fim;

    const falas = sa.recebidas.filter((m) => m.debate === ack.mensagem._id);
    assert.deepEqual(falas.map((m) => m.bot), ['gemini', 'gemini2', 'gemini', 'gemini2']);
    assert.deepEqual([...new Set(falas.map((m) => m.nomeAutor))], ['🤖 Moderador Gemini', '✨ Gemini 2']);
    assert.ok(falas.every((m) => !/^gemini 2:/i.test(m.texto) && !m.texto.includes('@')));
    assert.equal(chamadasMistral.length, 0);

    // Gemini 1 usa a chave/modelo principais; Gemini 2 usa os proprios
    assert.ok(!urlsGemini[0].includes('gemini-modelo-dois') && urlsGemini[0].includes('key=chave-falsa'));
    assert.ok(urlsGemini[1].includes('/gemini-modelo-dois:') && urlsGemini[1].includes('key=segunda-chave-gemini'));
    // Personalidades e papeis diferentes
    assert.match(chamadasGemini[0].systemInstruction.parts[0].text, /Voce e Gemini, .*chamada Gemini 2/);
    assert.match(chamadasGemini[1].systemInstruction.parts[0].text, /Voce e Gemini 2, .*chamada Gemini,[\s\S]*ironica/);
    // O Gemini 2 ve as falas do Gemini 1 como de outro participante
    assert.match(chamadasGemini[1].contents.at(-1).parts[0].text, /^Gemini: discordo/m);
  } finally {
    process.env.MISTRAL_API_KEY = chaveMistral;
    delete process.env.GEMINI_API_KEY_2;
    delete process.env.GEMINI_MODEL_2;
  }
});

// Deve ficar por ultimo: troca o modelo do Mistral em uso para o resto do processo
test('modelo do Mistral invalido: o servidor escolhe sozinho um modelo disponivel', async () => {
  modelosMistralAposentados.add('mistral-small-latest');
  const ana = await cadastrar('Ana');
  const sa = await conectado(cliente(ana.token));
  const fim = esperarFimDebate(sa);
  const ack = await emitir(sa, { texto: '@debate modelo aposentado', clientId: novoId(), debate: { turnos: 2, intervalo: 0 } });
  assert.equal(ack.ok, true, ack.erro);
  const final = await fim;
  assert.match(final.motivo, /Fim do debate/);

  assert.equal(consultasModelosMistral, 1);
  // Prefere um "small"; ignora embed e moderation
  assert.deepEqual(chamadasMistral.map((c) => c.corpo.model), ['mistral-small-latest', 'mistral-small-2599']);
  assert.ok(sa.recebidas.some((m) => m.debate && m.bot === 'mistral'));
});
