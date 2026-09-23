/**
 * Servico de clima — usado pelo Function Calling da IA.
 *
 * Usa a Open-Meteo, que e gratuita e NAO exige chave de API.
 * Sao duas chamadas: primeiro geocoding (nome da cidade -> lat/lon),
 * depois a previsao para aquelas coordenadas.
 */

const DESCRICOES = {
  0: 'ceu limpo',
  1: 'predominantemente limpo',
  2: 'parcialmente nublado',
  3: 'encoberto',
  45: 'nevoeiro',
  48: 'nevoeiro com geada',
  51: 'garoa fraca',
  53: 'garoa moderada',
  55: 'garoa intensa',
  61: 'chuva fraca',
  63: 'chuva moderada',
  65: 'chuva forte',
  71: 'neve fraca',
  73: 'neve moderada',
  75: 'neve forte',
  80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva moderadas',
  82: 'pancadas de chuva fortes',
  95: 'tempestade',
  96: 'tempestade com granizo',
  99: 'tempestade com granizo forte',
};

async function buscarJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resposta = await fetch(url, { signal: controller.signal });
    const textoBruto = await resposta.text();

    if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

    try {
      return textoBruto ? JSON.parse(textoBruto) : {};
    } catch {
      throw new Error(`resposta invalida do servico de clima: ${textoBruto.slice(0, 150) || '(vazio)'}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} cidade  Ex.: "Toquio", "Tokyo", "Sao Paulo"
 */
async function consultarClima(cidade) {
  if (!cidade || !cidade.trim()) {
    return { erro: 'Nome da cidade nao informado.' };
  }

  try {
    const urlGeo =
      'https://geocoding-api.open-meteo.com/v1/search' +
      `?name=${encodeURIComponent(cidade.trim())}&count=1&language=pt&format=json`;

    const geo = await buscarJson(urlGeo);

    if (!geo.results || geo.results.length === 0) {
      return { erro: `Nao encontrei a cidade "${cidade}".` };
    }

    const local = geo.results[0];

    const urlClima =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${local.latitude}&longitude=${local.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&timezone=auto';

    const clima = await buscarJson(urlClima);
    const atual = clima.current;

    return {
      cidade: local.name,
      pais: local.country || null,
      temperaturaC: atual.temperature_2m,
      sensacaoTermicaC: atual.apparent_temperature,
      umidadePercentual: atual.relative_humidity_2m,
      ventoKmh: atual.wind_speed_10m,
      condicao: DESCRICOES[atual.weather_code] || 'condicao desconhecida',
      horarioLocal: atual.time,
    };
  } catch (erro) {
    return { erro: 'Falha ao consultar o servico de clima: ' + erro.message };
  }
}

module.exports = { consultarClima };
