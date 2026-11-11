/**
 * Fuso horario usado nos agrupamentos do dashboard (por dia e por hora).
 * O MongoDB guarda as datas em UTC; sem isso, uma mensagem das 22h em Sao Paulo
 * cairia no "dia seguinte".
 *
 * ANALYTICS_TIMEZONE: nome IANA (padrao America/Sao_Paulo).
 */
function fusoValido(nome) {
  // Intl aceita timeZone undefined sem erro: exige um nome de verdade
  if (typeof nome !== 'string' || !nome.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: nome });
    return true;
  } catch {
    return false;
  }
}

const FUSO_ANALYTICS = fusoValido(process.env.ANALYTICS_TIMEZONE) ? process.env.ANALYTICS_TIMEZONE : 'America/Sao_Paulo';

const formatadorDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_ANALYTICS,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const formatadorHora = new Intl.DateTimeFormat('en-US', { timeZone: FUSO_ANALYTICS, hour: '2-digit', hourCycle: 'h23' });

/** 'AAAA-MM-DD' da data no fuso do dashboard (mesmo formato do $dateToString). */
function diaNoFuso(data) {
  return formatadorDia.format(new Date(data));
}

/** Hora 0-23 da data no fuso do dashboard (mesmo valor do $hour com timezone). */
function horaNoFuso(data) {
  return Number(formatadorHora.format(new Date(data))) % 24;
}

/** Lista dos ultimos `quantidade` dias ('AAAA-MM-DD'), do mais antigo para hoje. */
function ultimosDias(quantidade, agora = new Date()) {
  const dias = [];
  // Anda de 12 em 12 horas para nunca pular um dia por causa de horario de verao
  for (let t = agora.getTime(); dias.length < quantidade; t -= 12 * 3600 * 1000) {
    const dia = diaNoFuso(t);
    if (dias[0] !== dia) dias.unshift(dia);
  }
  return dias;
}

module.exports = { FUSO_ANALYTICS, diaNoFuso, horaNoFuso, ultimosDias };
