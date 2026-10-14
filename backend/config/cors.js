/**
 * Regra de CORS compartilhada entre o Express e o Socket.io.
 * Assim as duas portas de entrada da API aceitam exatamente as mesmas origens.
 *
 * CORS_ORIGIN: lista separada por virgula (ex.: https://meu-app.vercel.app).
 * Localhost e 127.0.0.1 sao sempre liberados para desenvolvimento.
 */
const origensPermitidas = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function origemPermitida(origin) {
  if (!origin) return true; // Postman, curl, health checks (sem cabecalho Origin)
  if (origensPermitidas.length === 0) return true;
  if (origensPermitidas.includes(origin)) return true;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return false;
}

// Assinatura (origin, callback) aceita tanto pelo pacote `cors` quanto pelo Socket.io
function verificarOrigem(origin, callback) {
  if (origemPermitida(origin)) return callback(null, true);
  return callback(new Error('Origem nao permitida pelo CORS: ' + origin));
}

module.exports = { verificarOrigem, origemPermitida };
