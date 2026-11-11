/**
 * Analytics do dashboard administrativo: consumo de tokens do Google Gemini.
 *
 * Todos os calculos acontecem DENTRO do MongoDB (Aggregation Pipeline com
 * $group e $sum). O Node so recebe os totais prontos, sem baixar as mensagens.
 */
const Mensagem = require('../models/Mensagem');
const Usuario = require('../models/Usuario');
const { FUSO_ANALYTICS, ultimosDias } = require('../config/fusoHorario');

const PERIODOS_PERMITIDOS = [7, 30, 90];
const PERIODO_PADRAO = 30;
const DIA_MS = 24 * 3600 * 1000;

/** Conta so os valores em que a condicao e verdadeira: { $sum: { $cond: [...] } } */
const somarSe = (condicao, valor = 1) => ({ $sum: { $cond: [condicao, valor, 0] } });

/**
 * Monta o pipeline. Datas de corte calculadas aqui; os agrupamentos por dia e por
 * hora usam o fuso horario do dashboard dentro do proprio MongoDB.
 */
function montarPipeline({ agora, dias, primeiroDia }) {
  const desde7Dias = new Date(agora.getTime() - 7 * DIA_MS);
  const desde30Dias = new Date(agora.getTime() - 30 * DIA_MS);
  // Primeiro um corte grosso por data (com 2 dias de folga por causa do fuso);
  // o corte exato e feito em seguida, pelo dia no fuso do dashboard
  const margemPeriodo = new Date(agora.getTime() - (dias + 2) * DIA_MS);
  const diaNoFuso = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: FUSO_ANALYTICS } };
  const filtroPeriodo = [
    { $match: { createdAt: { $gte: margemPeriodo } } },
    { $match: { $expr: { $gte: [diaNoFuso, primeiroDia] } } },
  ];
  const grupoPorHora = {
    _id: { $hour: { date: '$createdAt', timezone: FUSO_ANALYTICS } },
    mensagens: { $sum: 1 },
    tokens: { $sum: '$tokensGastos' },
  };

  return [
    {
      $facet: {
        // ---------- Totais gerais ----------
        totais: [
          {
            $group: {
              _id: null,
              totalTokens: { $sum: '$tokensGastos' },
              totalMensagens: { $sum: 1 },
              totalRespostasIA: somarSe({ $eq: ['$autor', 'model'] }),
              respostasComTokens: somarSe({ $gt: ['$tokensGastos', 0] }),
              tokensEntrada: { $sum: '$tokensEntrada' },
              tokensSaida: { $sum: '$tokensSaida' },
              tokensUltimos7Dias: somarSe({ $gte: ['$createdAt', desde7Dias] }, '$tokensGastos'),
              mensagensUltimos7Dias: somarSe({ $gte: ['$createdAt', desde7Dias] }),
              tokensUltimos30Dias: somarSe({ $gte: ['$createdAt', desde30Dias] }, '$tokensGastos'),
              mensagensUltimos30Dias: somarSe({ $gte: ['$createdAt', desde30Dias] }),
            },
          },
          {
            $project: {
              _id: 0,
              totalTokens: 1,
              totalMensagens: 1,
              totalRespostasIA: 1,
              respostasComTokens: 1,
              tokensEntrada: 1,
              tokensSaida: 1,
              tokensUltimos7Dias: 1,
              mensagensUltimos7Dias: 1,
              tokensUltimos30Dias: 1,
              mensagensUltimos30Dias: 1,
              // Media so entre as respostas da IA que tem consumo registrado
              mediaTokensPorResposta: {
                $cond: [
                  { $gt: ['$respostasComTokens', 0] },
                  { $round: [{ $divide: ['$totalTokens', '$respostasComTokens'] }, 1] },
                  0,
                ],
              },
            },
          },
        ],

        // ---------- Tokens e mensagens por dia (no fuso do dashboard) ----------
        porDia: [
          { $match: { createdAt: { $gte: margemPeriodo } } },
          { $addFields: { dia: diaNoFuso } },
          { $match: { dia: { $gte: primeiroDia } } },
          {
            $group: {
              _id: '$dia',
              tokens: { $sum: '$tokensGastos' },
              mensagens: { $sum: 1 },
              respostasIA: somarSe({ $eq: ['$autor', 'model'] }),
            },
          },
          { $sort: { _id: 1 } },
          // Consumo acumulado dentro do periodo, tambem calculado no MongoDB
          {
            $setWindowFields: {
              sortBy: { _id: 1 },
              output: { tokensAcumulados: { $sum: '$tokens', window: { documents: ['unbounded', 'current'] } } },
            },
          },
          { $project: { _id: 0, dia: '$_id', tokens: 1, mensagens: 1, respostasIA: 1, tokensAcumulados: 1 } },
        ],

        // ---------- Horarios de maior atividade (no periodo) ----------
        porHora: [
          ...filtroPeriodo,
          { $group: grupoPorHora },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, hora: '$_id', mensagens: 1, tokens: 1 } },
        ],
        horarioDePico: [
          ...filtroPeriodo,
          { $group: grupoPorHora },
          { $sort: { mensagens: -1, _id: 1 } },
          { $limit: 1 },
          { $project: { _id: 0, hora: '$_id', mensagens: 1 } },
        ],
      },
    },
  ];
}

const TOTAIS_VAZIOS = {
  totalTokens: 0,
  totalMensagens: 0,
  totalRespostasIA: 0,
  respostasComTokens: 0,
  tokensEntrada: 0,
  tokensSaida: 0,
  tokensUltimos7Dias: 0,
  mensagensUltimos7Dias: 0,
  tokensUltimos30Dias: 0,
  mensagensUltimos30Dias: 0,
  mediaTokensPorResposta: 0,
};

/**
 * Coloca zero nos dias sem mensagens, para o grafico mostrar o periodo inteiro.
 * Nenhuma soma de tokens acontece aqui: so preenche lacunas do resultado do MongoDB.
 */
function completarDias(diasDoPeriodo, porDia) {
  const porChave = new Map(porDia.map((d) => [d.dia, d]));
  let acumuladoAnterior = 0;
  return diasDoPeriodo.map((dia) => {
    const item = porChave.get(dia);
    if (item) acumuladoAnterior = item.tokensAcumulados;
    return {
      dia,
      tokens: item ? item.tokens : 0,
      mensagens: item ? item.mensagens : 0,
      respostasIA: item ? item.respostasIA : 0,
      tokensAcumulados: acumuladoAnterior,
    };
  });
}

function completarHoras(porHora) {
  const porChave = new Map(porHora.map((h) => [h.hora, h]));
  return Array.from({ length: 24 }, (_, hora) => porChave.get(hora) || { hora, mensagens: 0, tokens: 0 });
}

/**
 * GET /api/analytics/tokens?dias=7|30|90
 * Protegida por autenticarToken + apenasAdmin (routes/analyticsRoutes.js).
 */
async function obterAnaliseDeTokens(req, res, next) {
  try {
    const dias = PERIODOS_PERMITIDOS.includes(Number(req.query.dias)) ? Number(req.query.dias) : PERIODO_PADRAO;
    const agora = new Date();
    const diasDoPeriodo = ultimosDias(dias, agora);

    const [[resultado], totalUsuarios, totalAdmins] = await Promise.all([
      Mensagem.aggregate(montarPipeline({ agora, dias, primeiroDia: diasDoPeriodo[0] })),
      Usuario.countDocuments(),
      Usuario.countDocuments({ role: 'admin' }),
    ]);

    const totais = { ...TOTAIS_VAZIOS, ...(resultado.totais[0] || {}) };
    const dadosPorDia = completarDias(diasDoPeriodo, resultado.porDia);
    const porHora = completarHoras(resultado.porHora);
    const pico = resultado.horarioDePico[0] || null;

    return res.status(200).json({
      // Exigidos pela atividade
      totalTokens: totais.totalTokens,
      totalMensagens: totais.totalMensagens,
      totalUsuarios,
      tokensPorDia: dadosPorDia.map(({ dia, tokens, tokensAcumulados }) => ({ dia, tokens, tokensAcumulados })),
      mensagensPorDia: dadosPorDia.map(({ dia, mensagens, respostasIA }) => ({ dia, mensagens, respostasIA })),

      // Extras
      mediaTokensPorResposta: totais.mediaTokensPorResposta,
      totalRespostasIA: totais.totalRespostasIA,
      respostasComTokens: totais.respostasComTokens,
      tokensEntrada: totais.tokensEntrada,
      tokensSaida: totais.tokensSaida,
      totalAdmins,
      ultimos7Dias: { tokens: totais.tokensUltimos7Dias, mensagens: totais.mensagensUltimos7Dias },
      ultimos30Dias: { tokens: totais.tokensUltimos30Dias, mensagens: totais.mensagensUltimos30Dias },
      porHora,
      horarioDePico: pico,
      periodo: { dias, inicio: diasDoPeriodo[0], fim: diasDoPeriodo[diasDoPeriodo.length - 1], fusoHorario: FUSO_ANALYTICS },
      // O dashboard ignora eventos em tempo real de mensagens ja contadas aqui
      geradoEm: new Date().toISOString(),
    });
  } catch (erro) {
    return next(erro);
  }
}

module.exports = { obterAnaliseDeTokens, montarPipeline };
