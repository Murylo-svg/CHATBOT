const express = require('express');

const { autenticarToken } = require('../middlewares/auth');
const apenasAdmin = require('../middlewares/apenasAdmin');
const { obterAnaliseDeTokens } = require('../controllers/analyticsController');

const router = express.Router();

/**
 * GET /api/analytics/tokens?dias=7|30|90
 * 1. autenticarToken: valida o JWT e carrega o usuario (e o role) do MongoDB -> 401 sem token
 * 2. apenasAdmin: so passa role "admin" -> 403 para usuario comum
 * 3. obterAnaliseDeTokens: Aggregation Pipeline ($group + $sum) -> 200
 */
router.get(
  "/tokens",
  autenticarToken,
  apenasAdmin,
  obterAnaliseDeTokens
);

module.exports = router;
