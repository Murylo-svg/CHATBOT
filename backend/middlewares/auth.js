const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Usuario = require('../models/Usuario');

/**
 * Valida um JWT e devolve o payload ({ id, nome, exp, ... }).
 * Lanca erro (TokenExpiredError / JsonWebTokenError) se for invalido.
 * Usado pelo middleware HTTP abaixo e pelo handshake do Socket.io.
 */
function validarToken(token) {
  if (!token || typeof token !== 'string') {
    const erro = new Error('Token nao enviado.');
    erro.name = 'JsonWebTokenError';
    throw erro;
  }
  const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (!payload || !payload.id) {
    const erro = new Error('Token sem identificacao de usuario.');
    erro.name = 'JsonWebTokenError';
    throw erro;
  }
  return payload;
}

/**
 * Middleware de autenticacao.
 * Espera o header: Authorization: Bearer <token>
 * Se o token for valido, injeta req.usuarioId / req.usuario e segue.
 * Nao consulta o banco (rapido): use autenticarToken quando o papel importar.
 */
function lerTokenDoHeader(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

function responderTokenInvalido(res, erro) {
  const expirou = erro.name === 'TokenExpiredError';
  return res.status(401).json({
    erro: expirou ? 'Sessao expirada. Faca login novamente.' : 'Token invalido.',
    expirado: expirou,
  });
}

function verificarToken(req, res, next) {
  const token = lerTokenDoHeader(req);
  if (!token) {
    return res.status(401).json({ erro: 'Token nao enviado. Faca login novamente.' });
  }

  try {
    const payload = validarToken(token);
    req.usuarioId = payload.id;
    req.usuarioNome = payload.nome;
    req.usuario = { id: payload.id, nome: payload.nome };
    return next();
  } catch (erro) {
    return responderTokenInvalido(res, erro);
  }
}

/**
 * Autenticacao para rotas sensiveis (ex.: /api/analytics).
 * Alem de validar o JWT, busca o usuario no MongoDB a cada requisicao e preenche
 * req.usuario = { id, nome, email, role }.
 *
 * O papel (role) NUNCA vem do token nem do cliente: vem do banco. Assim, se um
 * administrador for rebaixado, ele perde o acesso na proxima requisicao, sem
 * esperar o token expirar.
 */
async function autenticarToken(req, res, next) {
  const token = lerTokenDoHeader(req);
  if (!token) {
    return res.status(401).json({ erro: 'Token nao enviado. Faca login novamente.' });
  }

  let payload;
  try {
    payload = validarToken(token);
  } catch (erro) {
    return responderTokenInvalido(res, erro);
  }

  if (!mongoose.isValidObjectId(payload.id)) {
    return res.status(401).json({ erro: 'Token invalido.' });
  }

  try {
    const usuario = await Usuario.findById(payload.id).select('nome email role').lean();
    if (!usuario) {
      return res.status(401).json({ erro: 'Usuario nao encontrado. Faca login novamente.' });
    }

    req.usuarioId = String(usuario._id);
    req.usuarioNome = usuario.nome;
    req.usuario = {
      id: String(usuario._id),
      nome: usuario.nome,
      email: usuario.email,
      role: usuario.role || 'user', // documentos antigos, sem o campo, sao "user"
    };
    return next();
  } catch (erro) {
    return next(erro);
  }
}

module.exports = verificarToken;
module.exports.verificarToken = verificarToken;
module.exports.autenticarToken = autenticarToken;
module.exports.validarToken = validarToken;
