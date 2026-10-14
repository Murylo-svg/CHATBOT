const jwt = require('jsonwebtoken');

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
 * Se o token for valido, injeta req.usuarioId e segue.
 */
function verificarToken(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token nao enviado. Faca login novamente.' });
  }

  const token = header.slice(7).trim();

  try {
    const payload = validarToken(token);
    req.usuarioId = payload.id;
    req.usuarioNome = payload.nome;
    return next();
  } catch (erro) {
    const expirou = erro.name === 'TokenExpiredError';
    return res.status(401).json({
      erro: expirou ? 'Sessao expirada. Faca login novamente.' : 'Token invalido.',
      expirado: expirou,
    });
  }
}

module.exports = verificarToken;
module.exports.validarToken = validarToken;
