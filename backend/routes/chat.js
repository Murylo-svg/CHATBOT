const express = require('express');
const multer = require('multer');

const Mensagem = require('../models/Message');
const verificarToken = require('../middleware/auth');
const { enviarImagem } = require('../services/cloudinary');
const { conversar } = require('../services/gemini');
const salaPublica = require('../services/salaPublica');

const router = express.Router();

// Todas as rotas deste arquivo exigem token
router.use(verificarToken);

// Upload em memoria: o buffer vai para o Cloudinary e para o Gemini
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter(req, arquivo, cb) {
    if (!arquivo.mimetype.startsWith('image/')) {
      return cb(new Error('Apenas arquivos de imagem sao aceitos.'));
    }
    cb(null, true);
  },
});

const LIMITE_HISTORICO = 20; // ultimas N mensagens enviadas como contexto

// Conversa privada = mensagens sem sala (as da sala publica tem sala: 'publica')
const PRIVADA = { sala: null };

/**
 * GET /api/chat/sala?limite=100
 * Historico inicial da sala publica em tempo real (mesmo formato do evento
 * `mensagemRecebida`, com _id para o front descartar repetidas).
 */
router.get('/sala', async (req, res, next) => {
  try {
    const mensagens = await salaPublica.buscarHistorico(req.query.limite);
    return res.json({ sala: salaPublica.SALA, mensagens });
  } catch (erro) {
    return next(erro);
  }
});

/**
 * GET /api/chat/historico
 * Conversa privada com o assistente (endpoint REST original).
 */
router.get('/historico', async (req, res, next) => {
  try {
    const mensagens = await Mensagem.find({ usuario: req.usuarioId, ...PRIVADA })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();

    return res.json({ mensagens });
  } catch (erro) {
    return next(erro);
  }
});

/**
 * DELETE /api/chat/historico
 * Apaga de verdade no banco, nao so na tela: a conversa privada, as mensagens
 * que o usuario enviou na sala publica e as respostas do Gemini a ele.
 * Quem estiver conectado na sala recebe `mensagensRemovidas` na hora.
 */
router.delete('/historico', async (req, res, next) => {
  try {
    const daSala = await Mensagem.find({ usuario: req.usuarioId, sala: salaPublica.SALA })
      .select('_id')
      .lean();
    const resultado = await Mensagem.deleteMany({ usuario: req.usuarioId });

    const ids = daSala.map((m) => String(m._id));
    const io = req.app.get('io');
    if (io && ids.length) io.emit('mensagensRemovidas', { ids });

    return res.json({
      mensagem: 'Historico apagado.',
      removidas: resultado.deletedCount,
      removidasDaSala: ids.length,
    });
  } catch (erro) {
    return next(erro);
  }
});

/**
 * POST /api/chat
 * multipart/form-data: { mensagem: string, imagem?: File }
 */
router.post('/', upload.single('imagem'), async (req, res, next) => {
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

    // ---------- 4. Conversa com a IA ----------
    const { texto: resposta, ferramentaUsada } = await conversar(historico, partesAtuais);

    // ---------- 5. Persiste os dois turnos ----------
    const [msgUsuario, msgIA] = await Mensagem.create([
      { usuario: req.usuarioId, autor: 'user', texto, imagemUrl },
      { usuario: req.usuarioId, autor: 'model', texto: resposta, ferramentaUsada },
    ]);

    return res.json({
      pergunta: msgUsuario,
      resposta: msgIA,
    });
  } catch (erro) {
    return next(erro);
  }
});

module.exports = router;
