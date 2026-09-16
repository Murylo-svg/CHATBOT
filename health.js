const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

/**
 * GET /api/health
 * ROTA PÚBLICA. Nunca coloque o middleware de JWT na frente dela:
 * o UptimeRobot e os balanceadores de carga precisam acessar sem token.
 */
router.get('/health', async (req, res) => {
  const timestamp = new Date().toISOString();

  // readyState: 0 desconectado | 1 conectado | 2 conectando | 3 desconectando
  const estados = ['desconectado', 'conectado', 'conectando', 'desconectando'];
  const estado = estados[mongoose.connection.readyState] || 'desconhecido';

  try {
    if (mongoose.connection.readyState !== 1) {
      throw new Error(`MongoDB nao esta conectado (estado: ${estado})`);
    }

    // Ping real no banco, com teto de 3s para a rota nunca travar
    await Promise.race([
      mongoose.connection.db.admin().command({ ping: 1 }),
      new Promise((_, rejeitar) =>
        setTimeout(() => rejeitar(new Error('Timeout no ping do MongoDB (3s)')), 3000)
      ),
    ]);

    return res.status(200).json({
      status: 'ok',
      bancoDeDados: 'conectado',
      uptimeSegundos: Math.floor(process.uptime()),
      ambiente: process.env.NODE_ENV || 'development',
      timestamp,
    });
  } catch (erro) {
    // 503 Service Unavailable: a API respondeu, mas uma dependencia critica caiu
    return res.status(503).json({
      status: 'erro',
      bancoDeDados: estado,
      mensagem: erro.message,
      timestamp,
    });
  }
});

module.exports = router;
