/* Camada de acesso à API: guarda o token e trata erros de sessão. */

// Chave do JWT no localStorage (a mesma lida pelo Socket.io no handshake)
const CHAVE_TOKEN = "token_saas";

// Migra sessões antigas, salvas antes da Sprint 7 na chave "token"
(function migrarTokenAntigo() {
  try {
    const antigo = localStorage.getItem("token");
    if (antigo && !localStorage.getItem(CHAVE_TOKEN)) localStorage.setItem(CHAVE_TOKEN, antigo);
    localStorage.removeItem("token");
  } catch {
    /* localStorage indisponível */
  }
})();

const Sessao = {
  salvar(token, usuario) {
    localStorage.setItem(CHAVE_TOKEN, token);
    localStorage.setItem("usuario", JSON.stringify(usuario));
  },
  token() {
    return localStorage.getItem(CHAVE_TOKEN);
  },
  usuario() {
    try {
      return JSON.parse(localStorage.getItem("usuario"));
    } catch {
      return null;
    }
  },
  limpar() {
    localStorage.removeItem(CHAVE_TOKEN);
    localStorage.removeItem("usuario");
  },
  logada() {
    return Boolean(localStorage.getItem(CHAVE_TOKEN));
  },
};

async function chamarApi(caminho, opcoes = {}) {
  const cabecalhos = { ...(opcoes.headers || {}) };

  const token = Sessao.token();
  if (token) cabecalhos["Authorization"] = "Bearer " + token;

  // Não define Content-Type para FormData: o navegador monta o boundary
  const ehFormData = opcoes.body instanceof FormData;
  if (!ehFormData && opcoes.body) cabecalhos["Content-Type"] = "application/json";

  let resposta;
  try {
    resposta = await fetch(API_URL + caminho, { ...opcoes, headers: cabecalhos });
  } catch {
    throw new Error("Não foi possível falar com o servidor. Verifique sua conexão.");
  }

  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    /* resposta sem corpo */
  }

  // Token inválido ou expirado: derruba a sessão e volta para o login
  if (resposta.status === 401 && Sessao.logada()) {
    Sessao.limpar();
    sessionStorage.setItem("motivoSaida", dados?.erro || "Sessão expirada.");
    window.location.replace("index.html");
    throw new Error(dados?.erro || "Sessão expirada.");
  }

  if (!resposta.ok) {
    throw new Error(dados?.erro || `Erro ${resposta.status}`);
  }

  return dados;
}
