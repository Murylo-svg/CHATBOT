/**
 * Segunda IA do chat: modelos abertos (Llama, da Meta) hospedados pela Groq.
 *
 * A Groq tem plano gratuito (sem cartao) e uma API no formato da OpenAI.
 * Chave em: https://console.groq.com/keys
 */
const { erroDeApi, comNovasTentativas } = require('./tentativas');

const BASE = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
// Remove espacos e aspas que costumam vir junto ao colar o valor no painel do Render
const MODELO = (process.env.GROQ_MODEL || '').trim().replace(/^["']|["']$/g, '').trim() || 'llama-3.3-70b-versatile';

// Modelo em uso. Muda sozinho se a Groq disser que o configurado nao existe mais.
let modeloAtivo = MODELO;

// Modelos que nao servem para conversa (audio, moderacao, etc.)
const NAO_CHAT = /whisper|tts|playai|guard|embed|distil|orpheus|prompt-guard|compound/i;

function modeloInexistente(erro) {
  return erro.status === 404 || /does not exist|model_not_found|decommissioned|not have access/i.test(erro.message);
}

/**
 * Consulta GET /models e escolhe um substituto: de preferencia um Llama,
 * priorizando "instant" (rapido, maior cota gratis) e depois "versatile".
 */
async function escolherModeloDisponivel(chave, recusado) {
  const resposta = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${chave}` } });
  if (!resposta.ok) return null;
  const dados = await resposta.json().catch(() => null);
  const ids = (dados?.data || [])
    .filter((m) => m && m.id && m.active !== false && m.id !== recusado && !NAO_CHAT.test(m.id))
    .map((m) => m.id);
  const pontuar = (id) =>
    (/llama/i.test(id) ? 100 : 0) + (/instant/i.test(id) ? 10 : 0) + (/versatile/i.test(id) ? 5 : 0);
  ids.sort((a, b) => pontuar(b) - pontuar(a) || a.localeCompare(b));
  return ids[0] || null;
}

function groqConfigurado() {
  return Boolean(process.env.GROQ_API_KEY);
}

/**
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} mensagens
 * @returns {Promise<string>} texto da resposta
 */
async function conversarGroq(mensagens, opcoes = {}) {
  try {
    return await comNovasTentativas(() => conversarGroqUmaVez(mensagens, opcoes), { rotulo: 'Groq' });
  } catch (erro) {
    if (!modeloInexistente(erro)) throw erro;
    const substituto = await escolherModeloDisponivel(process.env.GROQ_API_KEY, modeloAtivo).catch(() => null);
    if (!substituto) throw erro;
    console.warn(
      `[Groq] O modelo "${modeloAtivo}" nao esta disponivel. Usando "${substituto}". ` +
        'Atualize GROQ_MODEL no Render (lista em https://console.groq.com/docs/models).'
    );
    modeloAtivo = substituto;
    return comNovasTentativas(() => conversarGroqUmaVez(mensagens, opcoes), { rotulo: 'Groq' });
  }
}

async function conversarGroqUmaVez(mensagens, { maxTokens = 400, temperatura = 0.8 } = {}) {
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
        model: modeloAtivo,
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
      throw erroDeApi('Groq', resposta.status, `resposta invalida (HTTP ${resposta.status}): ${textoBruto.slice(0, 200) || '(vazio)'}`);
    }

    if (!resposta.ok) {
      throw erroDeApi('Groq', resposta.status, dados?.error?.message || `HTTP ${resposta.status}`);
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

module.exports = { conversarGroq, groqConfigurado, MODELO_GROQ: MODELO, modeloGroqEmUso: () => modeloAtivo };
