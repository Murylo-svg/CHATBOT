/**
 * Segunda IA do chat: modelos abertos (Llama, da Meta) hospedados pela Groq.
 *
 * A Groq tem plano gratuito (sem cartao) e uma API no formato da OpenAI.
 * Chave em: https://console.groq.com/keys
 */
const BASE = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const MODELO = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

function groqConfigurado() {
  return Boolean(process.env.GROQ_API_KEY);
}

/**
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} mensagens
 * @returns {Promise<string>} texto da resposta
 */
async function conversarGroq(mensagens, { maxTokens = 400, temperatura = 0.8 } = {}) {
  const chave = process.env.GROQ_API_KEY;
  if (!chave) throw new Error('GROQ_API_KEY nao definida no .env');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const resposta = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODELO,
        messages: mensagens,
        temperature: temperatura,
        max_tokens: maxTokens,
      }),
    });

    const textoBruto = await resposta.text();
    let dados;
    try {
      dados = textoBruto ? JSON.parse(textoBruto) : null;
    } catch {
      throw new Error(`Groq: resposta invalida (HTTP ${resposta.status}): ${textoBruto.slice(0, 200) || '(vazio)'}`);
    }

    if (!resposta.ok) {
      throw new Error('Groq: ' + (dados?.error?.message || `HTTP ${resposta.status}`));
    }

    const texto = dados?.choices?.[0]?.message?.content?.trim();
    if (!texto) throw new Error('Groq: resposta vazia.');
    return texto;
  } catch (erro) {
    if (erro.name === 'AbortError') throw new Error('Groq: tempo de resposta esgotado (30s).');
    throw erro;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { conversarGroq, groqConfigurado, MODELO_GROQ: MODELO };
