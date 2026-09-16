/* Camada de acesso à API: guarda o token e trata erros de sessão. */

const Sessao = {
  salvar(token, usuario) {
    localStorage.setItem("token", token);
    localStorage.setItem("usuario", JSON.stringify(usuario));
  },
  token() {
    return localStorage.getItem("token");
  },
  usuario() {
    try {
      return JSON.parse(localStorage.getItem("usuario"));
    } catch {
      return null;
    }
  },
  limpar() {
    localStorage.removeItem("token");
    localStorage.removeItem("usuario");
  },
  logada() {
    return Boolean(localStorage.getItem("token"));
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
