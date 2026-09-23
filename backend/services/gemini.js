const { consultarClima } = require('./weather');

const MODELO = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const INSTRUCAO_SISTEMA = `Voce e um assistente pessoal inteligente e prestativo, dentro de um aplicativo de chat.
Regras:
- Responda sempre em portugues do Brasil, de forma clara e direta.
- Voce tem memoria da conversa: use o historico para lembrar o nome da pessoa e o que ja foi dito.
- Quando receber uma imagem, descreva ou analise o que for perguntado sobre ela com precisao.
- Quando precisar de dados de clima em tempo real, use a ferramenta consultar_clima em vez de chutar.
- Nao invente informacoes. Se nao souber, diga que nao sabe.`;

// ---------- Ferramentas disponiveis para a IA ----------
const FERRAMENTAS = [
  {
    functionDeclarations: [
      {
        name: 'consultar_clima',
        description:
          'Consulta a condicao do tempo e a temperatura atual de uma cidade em tempo real. ' +
          'Use sempre que o usuario perguntar sobre clima, temperatura, chuva ou vento em algum lugar.',
        parameters: {
          type: 'OBJECT',
          properties: {
            cidade: {
              type: 'STRING',
              description: 'Nome da cidade. Exemplos: Toquio, Sao Paulo, Lisboa, Nova York.',
            },
          },
          required: ['cidade'],
        },
      },
    ],
  },
];

// Mapa nome da funcao -> implementacao real
const EXECUTORES = {
  consultar_clima: async (args) => consultarClima(args.cidade),
};

// ---------- Chamada HTTP ao Gemini ----------
async function chamarGemini(contents) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) throw new Error('GEMINI_API_KEY nao definida no .env');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const resposta = await fetch(`${BASE}/${MODELO}:generateContent?key=${chave}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCAO_SISTEMA }] },
        contents,
        tools: FERRAMENTAS,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1200 },
      }),
    });

    const dados = await resposta.json();

    if (!resposta.ok) {
      const msg = dados?.error?.message || `HTTP ${resposta.status}`;
      throw new Error('Gemini: ' + msg);
    }

    return dados;
  } catch (erro) {
    if (erro.name === 'AbortError') throw new Error('Gemini: tempo de resposta esgotado (45s).');
    throw erro;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Conversa com a IA, resolvendo chamadas de funcao automaticamente.
 *
 * @param {Array} historico  mensagens anteriores no formato do Gemini
 * @param {Array} partesAtuais  partes da mensagem nova (texto e/ou imagem)
 * @returns {Promise<{texto: string, ferramentaUsada: string|null}>}
 */
async function conversar(historico, partesAtuais) {
  const contents = [...historico, { role: 'user', parts: partesAtuais }];

  let ferramentaUsada = null;
  const MAX_VOLTAS = 3; // evita loop infinito de function calling

  for (let volta = 0; volta < MAX_VOLTAS; volta++) {
    const dados = await chamarGemini(contents);

    const candidato = dados.candidates?.[0];

    if (!candidato) {
      const bloqueio = dados.promptFeedback?.blockReason;
      if (bloqueio) return { texto: `Nao consegui responder: o conteudo foi bloqueado (${bloqueio}).`, ferramentaUsada };
      return { texto: 'Nao recebi resposta do modelo. Tente novamente.', ferramentaUsada };
    }

    const partes = candidato.content?.parts || [];
    const chamadas = partes.filter((p) => p.functionCall);

    // Sem chamada de funcao: e a resposta final
    if (chamadas.length === 0) {
      const texto = partes
        .map((p) => p.text || '')
        .join('')
        .trim();
      return { texto: texto || 'Nao consegui gerar uma resposta.', ferramentaUsada };
    }

    // Registra o turno do modelo (com a functionCall) no historico da chamada
    contents.push({ role: 'model', parts: candidato.content.parts });

    // Executa cada funcao pedida e devolve o resultado
    const respostas = [];
    for (const parte of chamadas) {
      const { name, args } = parte.functionCall;
      ferramentaUsada = name;

      const executor = EXECUTORES[name];
      const resultado = executor
        ? await executor(args || {})
        : { erro: `Funcao desconhecida: ${name}` };

      respostas.push({
        functionResponse: { name, response: resultado },
      });
    }

    contents.push({ role: 'user', parts: respostas });
  }

  return {
    texto: 'Nao consegui concluir a consulta apos varias tentativas. Tente reformular a pergunta.',
    ferramentaUsada,
  };
}

module.exports = { conversar };
