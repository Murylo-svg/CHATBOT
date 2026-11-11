const express = require('express');
const multer = require('multer');

const verificarToken = require('../middlewares/auth');
const chatController = require('../controllers/chatController');

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

// GET /api/chat/sala?limite=100 — historico inicial da sala publica (mesmo
// formato do evento `mensagemRecebida`, com _id para o front descartar repetidas)
router.get('/sala', chatController.historicoSala);

// GET /api/chat/historico — conversa privada com o assistente
router.get('/historico', chatController.listarHistorico);

// DELETE /api/chat/historico — apaga as mensagens do usuario no banco
router.delete('/historico', chatController.apagarHistorico);

// POST /api/chat — multipart/form-data: { mensagem: string, imagem?: File }
router.post('/', upload.single('imagem'), chatController.enviarMensagem);

module.exports = router;
