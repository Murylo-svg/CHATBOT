const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const Usuario = require('../models/User');
const verificarToken = require('../middleware/auth');

const router = express.Router();

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario._id.toString(), nome: usuario.nome },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

/**
 * POST /api/auth/register
 * body: { nome, email, senha }
 */
router.post('/register', async (req, res, next) => {
  try {
    const { nome, email, senha } = req.body || {};

    if (!nome || !email || !senha) {
      return res.status(400).json({ erro: 'Preencha nome, e-mail e senha.' });
    }
    if (senha.length < 6) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    }

    const jaExiste = await Usuario.findOne({ email: email.toLowerCase().trim() });
    if (jaExiste) {
      return res.status(409).json({ erro: 'Este e-mail ja esta cadastrado.' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    const usuario = await Usuario.create({ nome, email, senhaHash });

    return res.status(201).json({
      mensagem: 'Conta criada com sucesso.',
      token: gerarToken(usuario),
      usuario,
    });
  } catch (erro) {
    if (erro.name === 'ValidationError') {
      return res.status(400).json({ erro: Object.values(erro.errors)[0].message });
    }
    if (erro.code === 11000) {
      return res.status(409).json({ erro: 'Este e-mail ja esta cadastrado.' });
    }
    return next(erro);
  }
});

/**
 * POST /api/auth/login
 * body: { email, senha }
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, senha } = req.body || {};

    if (!email || !senha) {
      return res.status(400).json({ erro: 'Informe e-mail e senha.' });
    }

    const usuario = await Usuario.findOne({ email: email.toLowerCase().trim() });

    // Mensagem generica de proposito: nao revela se o e-mail existe
    if (!usuario || !(await bcrypt.compare(senha, usuario.senhaHash))) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    }

    return res.json({
      mensagem: 'Login realizado.',
      token: gerarToken(usuario),
      usuario,
    });
  } catch (erro) {
    return next(erro);
  }
});

/**
 * GET /api/auth/me  (protegida)
 * Usada pelo front para validar se o token ainda vale.
 */
router.get('/me', verificarToken, async (req, res, next) => {
  try {
    const usuario = await Usuario.findById(req.usuarioId);
    if (!usuario) return res.status(404).json({ erro: 'Usuario nao encontrado.' });
    return res.json({ usuario });
  } catch (erro) {
    return next(erro);
  }
});

module.exports = router;
