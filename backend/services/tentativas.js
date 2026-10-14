/**
 * Novas tentativas para APIs de IA (Gemini e Mistral).
 *
 * Erros como "This model is currently experiencing high demand" (HTTP 503),
 * limite de requisicoes (429) e falhas 5xx costumam passar em poucos segundos.
 * Nesses casos vale esperar um pouco e tentar de novo, em vez de desistir.
 */

const STATUS_TEMPORARIOS = new Set([408, 429, 500, 502, 503, 504]);

/** Cria o erro de uma API, marcando `temporario` quando vale tentar de novo. */
function erroDeApi(prefixo, status, mensagem) {
  const erro = new Error(`${prefixo}: ${mensagem}`);
  erro.status = status;
  erro.temporario =
    STATUS_TEMPORARIOS.has(status) || /high demand|overloaded|unavailable|try again later|rate limit/i.test(mensagem);
  return erro;
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executa `fn` e, se falhar com erro temporario, tenta de novo com espera crescente
 * (base, 2x base, ...), com um pouco de aleatoriedade para nao bater todos juntos.
 */
async function comNovasTentativas(fn, { tentativas = 3, rotulo = 'API' } = {}) {
  const base = Number(process.env.API_ESPERA_BASE_MS) || 1500;
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn(i);
    } catch (erro) {
      ultimoErro = erro;
      if (!erro.temporario || i === tentativas - 1) break;
      const espera = base * 2 ** i + Math.floor(Math.random() * 300);
      console.warn(`[${rotulo}] erro temporario (${erro.message}). Nova tentativa em ${espera}ms.`);
      await dormir(espera);
    }
  }
  throw ultimoErro;
}

module.exports = { erroDeApi, comNovasTentativas };
