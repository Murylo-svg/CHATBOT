const jwt = require('jsonwebtoken');

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
    const payload = jwt.verify(token, process.env.JWT_SECRET);
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
