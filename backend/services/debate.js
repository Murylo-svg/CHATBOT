/**
 * Debate entre duas IAs na sala publica.
 *
 * 🤖 Gemini (Google) e 🦙 Llama (Meta, via Groq) se revezam sobre um tema,
 * com um intervalo entre as falas para quem esta na sala conseguir ler.
 *
 * Seguranca contra loops e gastos:
 * - um debate por vez no servidor;
 * - numero de turnos limitado (DEBATE_TURNOS_MAX);
 * - qualquer pessoa da sala pode parar (@parar ou botao);
 * - para sozinho se todo mundo sair da sala ou se uma das IAs falhar.
 */
const Mensagem = require('../models/Message');
const { conversar } = require('./gemini');
const { conversarGroq, groqConfigurado } = require('./groq');
const sala = require('./salaPublica');

const num = (valor, padrao) => (Number.isFinite(Number(valor)) && valor !== '' && valor != null ? Number(valor) : padrao);

const CONFIG = {
  turnosPadrao: num(process.env.DEBATE_TURNOS, 8),
  turnosMax: num(process.env.DEBATE_TURNOS_MAX, 20),
  intervaloPadrao: num(process.env.DEBATE_INTERVALO_SEGUNDOS, 8),
  intervaloMin: num(process.env.DEBATE_INTERVALO_MIN_SEGUNDOS, 3),
  intervaloMax: 60,
};

const REGEX_DEBATE = /^\s*@debate\b\s*([\s\S]*)$/i;
const REGEX_PARAR = /^\s*@parar\b/i;

const FALANTES = {
  gemini: { nome: 'Gemini', outro: 'Llama', postura: 'Defenda com bons argumentos o lado A FAVOR (ou a visao mais otimista) do tema.' },
  llama: { nome: 'Llama', outro: 'Gemini', postura: 'Assuma o lado CONTRA (ou a visao mais critica e cetica) do tema.' },
};

function instrucaoDebate(bot, tema, turno, total) {
  const { nome, outro, postura } = FALANTES[bot];
  const ultimo = turno >= total - 2; // ultima fala de cada IA
  return `Voce e ${nome}, uma IA participando de um debate amigavel, ao vivo, com outra IA chamada ${outro}, numa sala de chat publica.
Tema: "${tema}".
${postura}
Regras:
- Responda em portugues do Brasil, em no maximo 3 frases curtas (uns 60 palavras).
- Reaja diretamente ao ultimo argumento de ${outro} e traga uma ideia nova. Nao repita o que ja foi dito.
- Seja respeitoso e bem-humorado. Nada de ofensas.
- Escreva so a sua fala: sem comecar com "${nome}:" e sem usar @ (nada de @gemini, @bot ou @debate).
- Esta e a fala ${turno + 1} de ${total}.${ultimo ? ' E a sua ULTIMA fala: faca um fechamento, resumindo sua posicao.' : ''}`;
}

/** Remove "Gemini:" no inicio, mencoes com @ e corta textos longos demais. */
function limparFala(texto) {
  return String(texto || '')
    .replace(/^\s*(🤖|🦙)?\s*\*{0,2}(gemini|llama)[^:\n]{0,25}:\*{0,2}\s*/i, '')
    .replace(/@(?=(gemini|bot|debate|parar)\b)/gi, '')
    .trim()
    .slice(0, 1500);
}

/** Junta turnos consecutivos do mesmo papel (as duas APIs preferem alternancia). */
function juntar(turnos) {
  const r = [];
  for (const t of turnos) {
    const ultimo = r[r.length - 1];
    if (ultimo && ultimo.role === t.role) ultimo.text += '\n' + t.text;
    else r.push({ ...t });
  }
  return r;
}

/**
 * Monta a conversa do ponto de vista de quem vai falar:
 * as proprias falas sao do "modelo"; as do adversario chegam como "usuario".
 */
function montarTurnos(bot, abertura, falas) {
  const nomeOutro = FALANTES[bot === 'gemini' ? 'llama' : 'gemini'].nome;
  const turnos = [{ role: 'user', text: abertura }];
  for (const f of falas) {
    turnos.push(f.bot === bot ? { role: 'model', text: f.texto } : { role: 'user', text: `${nomeOutro}: ${f.texto}` });
  }
  const juntos = juntar(turnos);
  if (juntos[juntos.length - 1].role !== 'user') juntos.push({ role: 'user', text: 'Continue o debate.' });
  return juntos;
}

async function falarGemini(tema, turno, total, abertura, falas) {
  const turnos = montarTurnos('gemini', abertura, falas);
  const atual = turnos.pop();
  const historico = turnos.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
  const { texto } = await conversar(historico, [{ text: atual.text }], {
    instrucao: instrucaoDebate('gemini', tema, turno, total),
  });
  return texto;
}

async function falarLlama(tema, turno, total, abertura, falas) {
  const turnos = montarTurnos('llama', abertura, falas);
  const mensagens = [
    { role: 'system', content: instrucaoDebate('llama', tema, turno, total) },
    ...turnos.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text })),
  ];
  return conversarGroq(mensagens);
}

const GERADORES = { gemini: falarGemini, llama: falarLlama };

class ErroDebate extends Error {}

function criarGerenciadorDebate(io) {
  let atual = null; // debate em andamento

  function estadoPublico() {
    if (!atual) return { ativo: false };
    return {
      ativo: true,
      tema: atual.tema,
      iniciadoPor: atual.iniciadoPor,
      turno: atual.turno,
      total: atual.total,
      intervalo: atual.intervalo,
      falando: atual.falando,
      nomeFalando: atual.falando ? sala.NOMES_BOT[atual.falando] : null,
      proximaEm: atual.proximaEm,
    };
  }

  function emitirEstado(extra = {}) {
    io.emit('debateEstado', { ...estadoPublico(), ...extra });
  }

  /** Lanca ErroDebate se nao der para comecar agora. Chamado ANTES de gravar a mensagem. */
  function validarInicio(tema, opcoes = {}) {
    if (atual) throw new ErroDebate(`Ja existe um debate em andamento sobre "${atual.tema}". Pare com @parar antes de comecar outro.`);
    if (!process.env.GEMINI_API_KEY) throw new ErroDebate('O debate precisa da GEMINI_API_KEY configurada no servidor.');
    if (!groqConfigurado()) throw new ErroDebate('O debate precisa da GROQ_API_KEY configurada no servidor (chave gratis em console.groq.com).');

    const temaLimpo = String(tema || '').replace(/\s+/g, ' ').trim();
    if (temaLimpo.length < 3) throw new ErroDebate('Diga o tema do debate. Ex.: @debate cachorro ou gato?');
    if (temaLimpo.length > 200) throw new ErroDebate('O tema do debate pode ter no maximo 200 caracteres.');

    let total = Math.round(num(opcoes.turnos, CONFIG.turnosPadrao));
    total = Math.min(Math.max(total, 2), CONFIG.turnosMax);

    let intervalo = num(opcoes.intervalo, CONFIG.intervaloPadrao);
    intervalo = Math.min(Math.max(intervalo, CONFIG.intervaloMin), CONFIG.intervaloMax);

    return { tema: temaLimpo, total, intervalo };
  }

  function parar(motivo) {
    if (!atual) return false;
    atual.parado = true;
    if (atual.acordar) atual.acordar();
    const tema = atual.tema;
    atual = null;
    io.emit('iaDigitando', { ativo: false });
    emitirEstado({ motivo: motivo || `Debate sobre "${tema}" encerrado.` });
    return true;
  }

  function dormir(debate, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(ms, 0));
      debate.acordar = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async function executar(debate) {
    const falas = [];
    const abertura = `Debate proposto por ${debate.iniciadoPor} na sala. Tema: "${debate.tema}". Comece.`;

    for (let turno = 0; turno < debate.total; turno++) {
      if (debate.parado) return;
      const bot = turno % 2 === 0 ? 'gemini' : 'llama';
      // Primeira fala sai rapido; as outras respeitam o intervalo escolhido
      const espera = turno === 0 ? Math.min(debate.intervalo * 1000, 2000) : debate.intervalo * 1000;

      debate.turno = turno;
      debate.falando = bot;
      debate.proximaEm = Date.now() + espera;
      emitirEstado();
      io.emit('iaDigitando', { ativo: true, bot, nome: sala.NOMES_BOT[bot] });

      const inicio = Date.now();
      let texto;
      try {
        texto = limparFala(await GERADORES[bot](debate.tema, turno, debate.total, abertura, falas));
      } catch (erro) {
        console.error(`[debate] ${bot} falhou:`, erro.message);
        if (!debate.parado) parar(`Debate interrompido: ${sala.NOMES_BOT[bot]} nao conseguiu responder (${erro.message}).`);
        return;
      }
      if (!texto) texto = '...';

      // A geracao ja gastou parte do intervalo; espera so o que falta
      await dormir(debate, espera - (Date.now() - inicio));
      if (debate.parado) return;

      const doc = await Mensagem.create({
        usuario: debate.usuarioId,
        autor: 'model',
        sala: sala.SALA,
        nomeAutor: sala.NOMES_BOT[bot],
        bot,
        texto,
        debate: debate.gatilhoId,
        respostaA: debate.gatilhoId,
      });
      if (debate.parado) return;

      falas.push({ bot, texto });
      io.emit('iaDigitando', { ativo: false });
      io.emit('mensagemRecebida', sala.serializar(doc.toObject()));
    }

    if (!debate.parado) parar(`Fim do debate sobre "${debate.tema}" (${debate.total} falas).`);
  }

  /**
   * Comeca o debate a partir da mensagem humana ja gravada (o "@debate tema").
   * `config` vem de validarInicio().
   */
  function iniciar(gatilho, usuario, config) {
    if (atual) throw new ErroDebate('Ja existe um debate em andamento.');
    const debate = {
      ...config,
      gatilhoId: gatilho._id,
      usuarioId: usuario.id,
      iniciadoPor: usuario.nome,
      turno: 0,
      falando: null,
      proximaEm: null,
      parado: false,
      acordar: null,
    };
    atual = debate;
    executar(debate).catch((erro) => {
      console.error('[debate] erro inesperado:', erro.message);
      if (atual === debate) parar('Debate interrompido por um erro no servidor.');
    });
    return debate;
  }

  return {
    validarInicio,
    iniciar,
    parar,
    estadoPublico,
    ativo: () => Boolean(atual),
  };
}

module.exports = {
  criarGerenciadorDebate,
  ErroDebate,
  REGEX_DEBATE,
  REGEX_PARAR,
  CONFIG_DEBATE: CONFIG,
  limparFala,
  montarTurnos,
};
