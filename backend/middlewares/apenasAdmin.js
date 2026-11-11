/**
 * Autorizacao (RBAC): deixa passar apenas administradores.
 *
 * Deve vir DEPOIS de autenticarToken, que valida o JWT e carrega
 * req.usuario do MongoDB (inclusive o role atual do banco):
 *
 *   router.get("/tokens", autenticarToken, apenasAdmin, controller);
 *
 * Sem token -> 401 (autenticarToken). Autenticado sem permissao -> 403 (aqui).
 */
function apenasAdmin(req, res, next) {
  const role = req.usuario && req.usuario.role;

  if (role === "admin") {
    return next();
  } else {
    return res.status(403).json({ erro: "Acesso negado: apenas administradores." });
  }
}

module.exports = apenasAdmin;
