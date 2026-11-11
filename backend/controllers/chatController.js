/**
 * Controller do chat: conversa privada (REST), resposta do Moderador Gemini na
 * sala publica e registro do consumo de tokens do Google Gemini.
 *
 * Todo lugar que grava uma resposta do Gemini passa por aqui:
 *   extrairTokensGastos(result) -> campos tokensGastos/tokensEntrada/tokensSaida/modeloIA
 *   registrarGastoDeToken(mensagem) -> evento "novoGastoDeToken" so para administradores
 */
const Mensagem = require('../models/Mensagem');
const { enviarImagem } = require('../services/cloudinary');
const { conversar, INSTRUCAO_MODERADOR } = require('../services/gemini');
const salaPublica = require('../services/salaPublica');
const { diaNoFuso, horaNoFuso } = require('../config/fusoHorario');

const LIMITE_HISTORICO = 20; // ultimas N mensagens enviadas como contexto

// Conversa privada = mensagens sem sala (as da sala publica tem sala: 'publica')
const PRIVADA = { sala: null };

// Campos de consumo: administrativos, nunca devolvidos ao usuario comum
const CAMPOS_ADMIN = '-tokensGastos -tokensEntrada -tokensSaida -modeloIA';

// Sala do Socket.io com os paineis de administradores (entrada conferida no banco)
const SALA_ADMINS = 'admins';
let io = null;

/** Chamado por socket/index.js ao subir: reaproveita o mesmo Socket.io do chat. */
function definirSocketIO(instancia) {
  io = instancia;
}

// ---------- Consumo de tokens ----------

const inteiroValido = (valor) => Number.isInteger(valor) && valor >= 0;

/**
 * Le o consumo REAL informado pelo Google no resultado do Gemini.
 * O resultado segue o formato do SDK oficial: result.response.usageMetadata.
 *
 * @returns {{tokensGastos: number, tokensEntrada: number, tokensSaida: number, modeloIA: string|null} | null}
 *   null quando nao ha metadados validos: nesse caso nada e registrado (nada de estimativa).
 */
function extrairTokensGastos(result) {
  const metadados = result && result.response && result.response.usageMetadata;
  if (!metadados) return null;

  const totalTokenCount = result.response.usageMetadata.totalTokenCount;
  if (!inteiroValido(totalTokenCount) || totalTokenCount === 0) return null;

  const valor = (campo) => (inteiroValido(metadados[campo]) ? metadados[campo] : 0);
  return {
    tokensGastos: totalTokenCount,
    // Entrada: o prompt (historico, imagem, instrucoes) e o retorno das ferramentas
    tokensEntrada: valor('promptTokenCount') + valor('toolUsePromptTokenCount'),
    // Saida: o texto gerado e o "raciocinio" do modelo (cobrado como saida)
    tokensSaida: valor('candidatesTokenCount') + valor('thoughtsTokenCount'),
    modeloIA: result.modelo || null,
  };
}

/**
 * Avisa os paineis administrativos que uma resposta do Gemini foi gravada.
 * Chamar SO depois de a mensagem estar salva no MongoDB.
 *
 * O evento vai apenas para a sala "admins" (usuarios comuns nunca recebem).
 * Primeiro argumento: a quantidade de tokens, como pede a atividade.
 * Segundo: detalhes para o dashboard nao contar a mesma mensagem duas vezes.
 */
function registrarGastoDeToken(mensagem, origem) {
  const quantidade = mensagem && mensagem.tokensGastos;
  if (!io || !inteiroValido(quantidade) || quantidade === 0) return false;

  const criadaEm = mensagem.createdAt || new Date();
  io.to(SALA_ADMINS).emit("novoGastoDeToken", quantidade, {
    mensagemId: String(mensagem._id),
    createdAt: new Date(criadaEm).toISOString(),
    dia: diaNoFuso(criadaEm),
    hora: horaNoFuso(criadaEm),
    origem,
    modelo: mensagem.modeloIA || null,
  });
  return true;
}

// ---------- Sala publica: resposta a @gemini / @bot ----------

/**
 * Pede ao Gemini a resposta para uma mensagem que mencionou o bot, grava com o
 * consumo de tokens e avisa os administradores.
 * @returns {Promise<object>} a resposta gravada (objeto simples)
 */
async function responderMencaoGemini(gatilho, imagem) {
  const { historico, partesAtuais } = await salaPublica.montarContextoModerador(gatilho, imagem);

  const result = await conversar(historico, partesAtuais, { instrucao: INSTRUCAO_MODERADOR });
  const consumo = extrairTokensGastos(result);

  const doc = await Mensagem.create({
    usuario: gatilho.usuario,
    autor: 'model',
    sala: salaPublica.SALA,
    nomeAutor: salaPublica.NOME_MODERADOR,
    bot: 'gemini',
    texto: result.texto,
    ferramentaUsada: result.ferramentaUsada,
    respostaA: gatilho._id,
    ...consumo,
  });

  const resposta = doc.toObject();
  registrarGastoDeToken(resposta, 'sala');
  return resposta;
}

// ---------- Rotas REST (routes/chat.js) ----------

/** GET /api/chat/sala?limite=100 — historico inicial da sala publica */
async function historicoSala(req, res, next) {
  try {
    const mensagens = await salaPublica.buscarHistorico(req.query.limite);
    return res.json({ sala: salaPublica.SALA, mensagens });
  } catch (erro) {
    return next(erro);
  }
}

/** GET /api/chat/historico — conversa privada com o assistente */
async function listarHistorico(req, res, next) {
  try {
    const mensagens = await Mensagem.find({ usuario: req.usuarioId, ...PRIVADA })
      .select(CAMPOS_ADMIN)
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();

    return res.json({ mensagens });
  } catch (erro) {
    return next(erro);
  }
}

/**
 * DELETE /api/chat/historico
 * Apaga de verdade no banco, nao so na tela: a conversa privada, as mensagens
 * que o usuario enviou na sala publica e as respostas do Gemini a ele.
 * Quem estiver conectado na sala recebe `mensagensRemovidas` na hora.
 */
async function apagarHistorico(req, res, next) {
  try {
    const daSala = await Mensagem.find({ usuario: req.usuarioId, sala: salaPublica.SALA })
      .select('_id')
      .lean();
    const resultado = await Mensagem.deleteMany({ usuario: req.usuarioId });

    const ids = daSala.map((m) => String(m._id));
    const socketIo = req.app.get('io');
    if (socketIo && ids.length) socketIo.emit('mensagensRemovidas', { ids });

    return res.json({
      mensagem: 'Historico apagado.',
      removidas: resultado.deletedCount,
      removidasDaSala: ids.length,
    });
  } catch (erro) {
    return next(erro);
  }
}

/**
 * POST /api/chat — conversa privada
 * multipart/form-data: { mensagem: string, imagem?: File }
 */
async function enviarMensagem(req, res, next) {
  try {
    const texto = (req.body.mensagem || '').trim();
    const arquivo = req.file;

    if (!texto && !arquivo) {
      return res.status(400).json({ erro: 'Envie uma mensagem ou uma imagem.' });
    }

    // ---------- 1. Upload da imagem (se houver) ----------
    let imagemUrl = null;
    if (arquivo) {
      imagemUrl = await enviarImagem(arquivo.buffer, req.usuarioId);
    }

    // ---------- 2. Monta o historico no formato do Gemini ----------
    const anteriores = await Mensagem.find({ usuario: req.usuarioId, ...PRIVADA })
      .sort({ createdAt: -1 })
      .limit(LIMITE_HISTORICO)
      .lean();

    const historico = anteriores
      .reverse()
      .map((m) => ({
        role: m.autor,
        parts: [{ text: m.texto || (m.imagemUrl ? '[imagem enviada]' : '') }],
      }))
      .filter((m) => m.parts[0].text);

    // O Gemini exige que o historico comece com role 'user'
    while (historico.length && historico[0].role !== 'user') {
      historico.shift();
    }

    // ---------- 3. Partes da mensagem atual ----------
    const partesAtuais = [];
    if (arquivo) {
      partesAtuais.push({
        inlineData: {
          mimeType: arquivo.mimetype,
          data: arquivo.buffer.toString('base64'),
        },
      });
    }
    partesAtuais.push({ text: texto || 'Descreva esta imagem.' });

    // ---------- 4. Conversa com a IA e le o consumo real de tokens ----------
    const result = await conversar(historico, partesAtuais);
    const consumo = extrairTokensGastos(result);

    // ---------- 5. Persiste os dois turnos (o consumo fica na resposta da IA) ----------
    const [msgUsuario, msgIA] = await Mensagem.create([
      { usuario: req.usuarioId, autor: 'user', texto, imagemUrl },
      { usuario: req.usuarioId, autor: 'model', texto: result.texto, ferramentaUsada: result.ferramentaUsada, ...consumo },
    ]);

    registrarGastoDeToken(msgIA, 'chat-privado');

    return res.json({
      pergunta: msgUsuario,
      resposta: msgIA,
    });
  } catch (erro) {
    return next(erro);
  }
}

module.exports = {
  SALA_ADMINS,
  definirSocketIO,
  extrairTokensGastos,
  registrarGastoDeToken,
  responderMencaoGemini,
  historicoSala,
  listarHistorico,
  apagarHistorico,
  enviarMensagem,
};
