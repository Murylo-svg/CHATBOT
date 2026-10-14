/**
 * Regras da sala publica em tempo real: validacao, persistencia,
 * historico e a resposta do Moderador Gemini.
 *
 * Fica separado do socket/ para poder ser reutilizado pelas rotas REST
 * (historico inicial) e testado sem precisar de uma conexao WebSocket.
 */
const Mensagem = require('../models/Message');
const { conversar, INSTRUCAO_MODERADOR } = require('./gemini');

const SALA = 'publica';
const NOME_MODERADOR = '🤖 Moderador Gemini';
// 'llama' fica para exibir falas antigas, de quando a segunda IA era o Llama da Groq
const NOMES_BOT = {
  gemini: NOME_MODERADOR,
  gemini2: '✨ Gemini 2',
  mistral: '🌀 Mistral',
  llama: '🦙 Llama (Groq)',
};
const LIMITE_TEXTO = 2000; // caracteres por mensagem
const LIMITE_IMAGEM = 5 * 1024 * 1024; // 5 MB, igual ao upload REST
const LIMITE_CONTEXTO_IA = 20; // mensagens da sala enviadas como memoria ao Gemini
const LIMITE_HISTORICO = 100; // mensagens devolvidas no carregamento inicial

// @gemini ou @bot como palavra isolada (nao pega "email@gemini.com" nem "@botao")
const REGEX_MENCAO = /(^|[^\w@.])@(gemini|bot)(?![\w-])/i;

// Assinaturas binarias dos formatos aceitos. Nao confiamos no mimetype do cliente.
const ASSINATURAS = [
  { tipo: 'image/jpeg', testar: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    tipo: 'image/png',
    testar: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { tipo: 'image/gif', testar: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  {
    tipo: 'image/webp',
    testar: (b) =>
      b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
  },
];

class ErroValidacao extends Error {}

function mencionaBot(texto) {
  return REGEX_MENCAO.test(texto || '');
}

/**
 * Limpa e valida o texto. Remove caracteres de controle (menos \n e \t),
 * normaliza quebras de linha e rejeita mensagens grandes demais.
 */
function validarTexto(bruto) {
  if (bruto === undefined || bruto === null) return '';
  if (typeof bruto !== 'string') throw new ErroValidacao('Mensagem em formato invalido.');

  const texto = bruto
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  if (texto.length > LIMITE_TEXTO) {
    throw new ErroValidacao(`A mensagem passou de ${LIMITE_TEXTO} caracteres.`);
  }
  return texto;
}

function validarClientId(clientId) {
  if (clientId === undefined || clientId === null) return undefined;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) {
    throw new ErroValidacao('Identificador da mensagem invalido.');
  }
  return clientId;
}

/**
 * Converte o anexo recebido pelo socket em Buffer e confere tamanho e formato.
 * @returns {{ buffer: Buffer, mimeType: string } | null}
 */
function validarImagem(imagem) {
  if (!imagem) return null;
  const dados = imagem.dados;

  let buffer;
  if (Buffer.isBuffer(dados)) buffer = dados;
  else if (dados instanceof ArrayBuffer) buffer = Buffer.from(dados);
  else if (ArrayBuffer.isView(dados)) buffer = Buffer.from(dados.buffer, dados.byteOffset, dados.byteLength);
  else throw new ErroValidacao('Imagem em formato invalido.');

  if (buffer.length === 0) throw new ErroValidacao('A imagem esta vazia.');
  if (buffer.length > LIMITE_IMAGEM) throw new ErroValidacao('Imagem muito grande. O limite e de 5 MB.');

  const formato = ASSINATURAS.find((a) => a.testar(buffer));
  if (!formato) throw new ErroValidacao('Formato de imagem nao suportado. Use JPG, PNG, GIF ou WEBP.');

  return { buffer, mimeType: formato.tipo };
}

/** Formato publico de uma mensagem (o mesmo no REST e no WebSocket). */
function serializar(m) {
  const ehBot = m.autor === 'model';
  return {
    _id: String(m._id),
    sala: m.sala || SALA,
    autor: m.autor,
    usuario: ehBot ? null : String(m.usuario),
    nomeAutor: ehBot ? NOMES_BOT[m.bot] || NOME_MODERADOR : m.nomeAutor || 'Usuario',
    bot: ehBot ? m.bot || 'gemini' : null,
    debate: m.debate ? String(m.debate) : null,
    texto: m.texto || '',
    imagemUrl: m.imagemUrl || null,
    ferramentaUsada: m.ferramentaUsada || null,
    respostaA: m.respostaA ? String(m.respostaA) : null,
    clientId: ehBot ? null : m.clientId || null,
    createdAt: m.createdAt,
  };
}

/** Ultimas mensagens da sala, em ordem cronologica. */
async function buscarHistorico(limite = LIMITE_HISTORICO) {
  const recentes = await Mensagem.find({ sala: SALA })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(Math.max(Number(limite) || LIMITE_HISTORICO, 1), 200))
    .lean();
  return recentes.reverse().map(serializar);
}

/** Procura uma mensagem ja gravada com o mesmo clientId (reenvio apos reconexao). */
async function buscarDuplicada(usuarioId, clientId) {
  if (!clientId) return null;
  return Mensagem.findOne({ usuario: usuarioId, clientId, sala: SALA }).lean();
}

/**
 * Grava a mensagem humana. Se o clientId ja existir, devolve a existente
 * com `duplicada: true` em vez de gravar outra vez.
 */
async function salvarMensagemHumana({ usuario, texto, imagemUrl, clientId }) {
  try {
    const doc = await Mensagem.create({
      usuario: usuario.id,
      autor: 'user',
      sala: SALA,
      nomeAutor: usuario.nome,
      texto,
      imagemUrl: imagemUrl || null,
      clientId,
    });
    return { mensagem: doc.toObject(), duplicada: false };
  } catch (erro) {
    if (erro.code === 11000 && clientId) {
      const existente = await buscarDuplicada(usuario.id, clientId);
      if (existente) return { mensagem: existente, duplicada: true };
    }
    throw erro;
  }
}

/**
 * Junta turnos consecutivos do mesmo papel: o Gemini espera
 * alternancia user/model e o historico da sala tem varias pessoas seguidas.
 */
function juntarTurnos(turnos) {
  const resultado = [];
  for (const turno of turnos) {
    const ultimo = resultado[resultado.length - 1];
    if (ultimo && ultimo.role === turno.role) {
      ultimo.parts[0].text += '\n' + turno.parts[0].text;
    } else {
      resultado.push({ role: turno.role, parts: [{ text: turno.parts[0].text }] });
    }
  }
  while (resultado.length && resultado[0].role !== 'user') resultado.shift();
  return resultado;
}

// Mensagens do proprio Gemini contam como turno 'model'; as das pessoas e as do Mistral, como 'user'
function ehDoGemini(m) {
  return m.autor === 'model' && (m.bot || 'gemini') === 'gemini';
}

function textoParaIA(m) {
  const conteudo = (m.texto || '') + (m.imagemUrl ? (m.texto ? ' ' : '') + '[enviou uma imagem]' : '');
  if (!conteudo) return '';
  if (ehDoGemini(m)) return conteudo;
  const nome = m.autor === 'model' ? NOMES_BOT[m.bot] : m.nomeAutor || 'Usuario';
  return `${nome}: ${conteudo}`;
}

/**
 * Pede ao Gemini a resposta para uma mensagem que mencionou o bot e grava.
 * A memoria da IA sao as ultimas mensagens da propria sala.
 *
 * @param {object} gatilho  mensagem humana (lean) que mencionou o bot
 * @param {{buffer: Buffer, mimeType: string}|null} imagem  anexo da mensagem, se houver
 */
async function gerarRespostaModerador(gatilho, imagem) {
  const anteriores = await Mensagem.find({ sala: SALA, createdAt: { $lte: gatilho.createdAt }, _id: { $ne: gatilho._id } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(LIMITE_CONTEXTO_IA)
    .lean();

  const historico = juntarTurnos(
    anteriores
      .reverse()
      .map((m) => ({ role: ehDoGemini(m) ? 'model' : 'user', parts: [{ text: textoParaIA(m) }] }))
      .filter((t) => t.parts[0].text)
  );

  const partesAtuais = [];
  if (imagem) {
    partesAtuais.push({ inlineData: { mimeType: imagem.mimeType, data: imagem.buffer.toString('base64') } });
  }
  partesAtuais.push({
    text: `${gatilho.nomeAutor}: ${gatilho.texto || 'Descreva esta imagem.'}`,
  });

  const { texto, ferramentaUsada } = await conversar(historico, partesAtuais, {
    instrucao: INSTRUCAO_MODERADOR,
  });

  const doc = await Mensagem.create({
    usuario: gatilho.usuario,
    autor: 'model',
    sala: SALA,
    nomeAutor: NOME_MODERADOR,
    bot: 'gemini',
    texto,
    ferramentaUsada,
    respostaA: gatilho._id,
  });
  return doc.toObject();
}

module.exports = {
  SALA,
  NOME_MODERADOR,
  NOMES_BOT,
  LIMITE_TEXTO,
  LIMITE_IMAGEM,
  ErroValidacao,
  mencionaBot,
  validarTexto,
  validarClientId,
  validarImagem,
  serializar,
  buscarHistorico,
  buscarDuplicada,
  salvarMensagemHumana,
  gerarRespostaModerador,
  juntarTurnos,
};
