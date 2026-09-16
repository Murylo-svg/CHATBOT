/* Luz indicadora: consulta /api/health e mostra se o sistema está no ar. */

(function () {
  const caixa = document.getElementById("status");
  if (!caixa) return;

  const luz = caixa.querySelector(".luz");
  const rotulo = caixa.querySelector(".rotulo");

  function pintar(cor, texto, piscando, detalhe) {
    luz.style.background = cor;
    luz.classList.toggle("piscando", piscando);
    rotulo.textContent = texto;
    caixa.title = detalhe || texto;
  }

  async function checar() {
    pintar("#9aa5a0", "Verificando", true);

    const controlador = new AbortController();
    const prazo = setTimeout(() => controlador.abort(), 10000);

    try {
      const resposta = await fetch(API_URL + "/api/health", {
        signal: controlador.signal,
        cache: "no-store",
      });
      if (!resposta.ok) throw new Error("HTTP " + resposta.status);

      const dados = await resposta.json();
      pintar("#1f6b4a", "Sistema operacional", false, "Banco de dados: " + dados.bancoDeDados);
    } catch (erro) {
      const motivo = erro.name === "AbortError" ? "Tempo esgotado" : erro.message;
      pintar("#b4362f", "API offline", true, motivo);
    } finally {
      clearTimeout(prazo);
    }
  }

  checar();
  setInterval(checar, 60000);
  caixa.addEventListener("click", checar);
})();
