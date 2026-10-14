/**
 * Segunda IA do chat: Mistral (Mistral AI, Franca).
 *
 * Plano gratuito "Experiment": sem cartao, so pede verificacao por telefone.
 * Chave em: https://console.mistral.ai/api-keys
 *
 * Usamos apelidos como "mistral-small-latest", que sempre apontam para a versao
 * atual do modelo. Assim ele nao "some" quando a Mistral lanca uma versao nova.
 */
const { erroDeApi, comNovasTentativas } = require('./tentativas');

const BASE = process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1';
// Remove espacos e aspas que costumam vir junto ao colar o valor no painel do Render
const MODELO =
  (process.env.MISTRAL_MODEL || '').trim().replace(/^["']|["']$/g, '').trim() || 'mistral-small-latest';

// Modelo em uso. Muda sozinho se a Mistral disser que o configurado nao existe.
let modeloAtivo = MODELO;

// Modelos que nao servem para conversa
const NAO_CHAT = /embed|moderation|ocr|transcri/i;

function mistralConfigurado() {
  return Boolean(process.env.MISTRAL_API_KEY);
}

function modeloInexistente(erro) {
  return erro.status === 404 || /invalid model|does not exist|not found|no access|deprecated/i.test(erro.message);
}

/**
 * Consulta GET /models e escolhe um substituto que converse,
 * priorizando os apelidos "-latest" do Mistral Small.
 */
async function escolherModeloDisponivel(chave, recusado) {
  const resposta = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${chave}` } });
  if (!resposta.ok) return null;
  const dados = await resposta.json().catch(() => null);
  const ids = (dados?.data || [])
    .filter((m) => m && m.id && m.id !== recusado && !NAO_CHAT.test(m.id))
    .filter((m) => !m.capabilities || m.capabilities.completion_chat !== false)
    .map((m) => m.id);
  const pontuar = (id) => (/small/i.test(id) ? 10 : 0) + (/latest/i.test(id) ? 5 : 0) + (/mistral/i.test(id) ? 2 : 0);
  ids.sort((a, b) => pontuar(b) - pontuar(a) || a.localeCompare(b));
  return ids[0] || null;
}

/**
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} mensagens
 * @returns {Promise<string>} texto da resposta
 */
async function conversarMistral(mensagens, opcoes = {}) {
  try {
    return await comNovasTentativas(() => conversarMistralUmaVez(mensagens, opcoes), { rotulo: 'Mistral' });
  } catch (erro) {
    if (!modeloInexistente(erro)) throw erro;
    const substituto = await escolherModeloDisponivel(process.env.MISTRAL_API_KEY, modeloAtivo).catch(() => null);
    if (!substituto) throw erro;
    console.warn(
      `[Mistral] O modelo "${modeloAtivo}" nao esta disponivel. Usando "${substituto}". ` +
        'Atualize MISTRAL_MODEL no Render (lista em https://docs.mistral.ai/getting-started/models/).'
    );
    modeloAtivo = substituto;
    return comNovasTentativas(() => conversarMistralUmaVez(mensagens, opcoes), { rotulo: 'Mistral' });
  }
}

// A resposta pode vir como texto ou como lista de pedacos ({ type: 'text', text })
function extrairTexto(conteudo) {
  if (typeof conteudo === 'string') return conteudo.trim();
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((p) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : ''))
      .join('')
      .trim();
  }
  return '';
}

async function conversarMistralUmaVez(mensagens, { maxTokens = 400, temperatura = 0.8 } = {}) {
  const chave = process.env.MISTRAL_API_KEY;
  if (!chave) throw new Error('MISTRAL_API_KEY nao definida no .env');

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
      throw erroDeApi('Mistral', resposta.status, `resposta invalida (HTTP ${resposta.status}): ${textoBruto.slice(0, 200) || '(vazio)'}`);
    }

    if (!resposta.ok) {
      const detalhe = typeof dados?.detail === 'string' ? dados.detail : dados?.detail && JSON.stringify(dados.detail);
      const msg = dados?.message || dados?.error?.message || detalhe || `HTTP ${resposta.status}`;
      throw erroDeApi('Mistral', resposta.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    const texto = extrairTexto(dados?.choices?.[0]?.message?.content);
    if (!texto) throw new Error('Mistral: resposta vazia.');
    return texto;
  } catch (erro) {
    if (erro.name === 'AbortError') throw new Error('Mistral: tempo de resposta esgotado (30s).');
    throw erro;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  conversarMistral,
  mistralConfigurado,
  MODELO_MISTRAL: MODELO,
  modeloMistralEmUso: () => modeloAtivo,
};
