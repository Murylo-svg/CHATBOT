/* Painel administrativo: métricas de consumo do Gemini (API + Chart.js + Socket.io).
   Os dados vêm SÓ de /api/analytics/tokens, que exige JWT + role admin no servidor. */

(function () {
  // ---------- Guarda de rota (conveniência; quem protege os dados é a API) ----------
  if (!Sessao.logada()) {
    window.location.replace("index.html");
    return;
  }

  const $ = (id) => document.getElementById(id);
  const conteudo = $("conteudo");
  const acessoNegado = $("acesso-negado");
  const avisoPainel = $("aviso-painel");
  const aoVivo = $("ao-vivo");
  const atualizadoEm = $("atualizado-em");
  const botaoAtualizar = $("atualizar");
  const botoesPeriodo = document.querySelectorAll(".segmentado button");

  const usuario = Sessao.usuario();
  $("quem-admin").textContent = usuario ? usuario.nome : "";

  // Cores do projeto (css/style.css): uma cor por gráfico, sem legenda (o título nomeia a série)
  const CORES = {
    tokens: "#1f6b4a",
    mensagens: "#3b6e8f",
    horas: "#4f8a6c",
    pico: "#1f6b4a",
    grade: "#e3e8e2",
    texto: "#5c6a64",
  };

  const numero = new Intl.NumberFormat("pt-BR");
  const decimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
  const fmt = (v) => numero.format(Math.round(v || 0));
  const diaCurto = (dia) => dia.slice(8, 10) + "/" + dia.slice(5, 7);

  let periodo = 30;
  try {
    const salvo = Number(localStorage.getItem("painelPeriodo"));
    if ([7, 30, 90].includes(salvo)) periodo = salvo;
  } catch {
    /* sem localStorage */
  }

  let dados = null; // última resposta da API (atualizada também pelos eventos ao vivo)
  let geradoEm = null; // eventos de mensagens criadas antes disto já estão em `dados`
  const vistos = new Set(); // mensagemId já somados ao vivo (reconexão não duplica)
  let carregando = false;
  let timerSincronizar = null;
  let socket = null;
  let negado = false;
  const graficos = {};

  // ---------- Estados visuais ----------
  function avisar(texto, tipo = "erro") {
    avisoPainel.textContent = texto;
    avisoPainel.className = "aviso-painel " + tipo;
    avisoPainel.hidden = !texto;
  }

  function estadoAoVivo(classe, rotulo) {
    aoVivo.className = "conexao " + classe;
    aoVivo.textContent = rotulo;
  }

  function marcarCarregando(ativo) {
    document.querySelectorAll(".card, .grafico-area").forEach((el) => el.classList.toggle("carregando", ativo));
  }

  function mostrarAcessoNegado(mensagem) {
    negado = true;
    conteudo.hidden = true;
    acessoNegado.hidden = false;
    if (mensagem) $("acesso-negado-texto").textContent = mensagem;
    estadoAoVivo("erro", "Sem acesso");
    dados = null;
    Object.values(graficos).forEach((g) => g.destroy());
    if (socket) socket.disconnect();
  }

  // ---------- Cards ----------
  function pintarCards() {
    $("valor-usuarios").textContent = fmt(dados.totalUsuarios);
    $("detalhe-usuarios").textContent =
      dados.totalAdmins + (dados.totalAdmins === 1 ? " administrador" : " administradores");

    $("valor-mensagens").textContent = fmt(dados.totalMensagens);
    $("detalhe-mensagens").textContent =
      fmt(dados.ultimos7Dias.mensagens) + " nos últimos 7 dias · " + fmt(dados.totalRespostasIA) + " da IA";

    $("valor-tokens").textContent = fmt(dados.totalTokens);
    $("detalhe-tokens").textContent =
      "Entrada " + fmt(dados.tokensEntrada) + " · saída " + fmt(dados.tokensSaida);

    $("valor-media").textContent = decimal.format(dados.mediaTokensPorResposta || 0);
    $("detalhe-media").textContent =
      "tokens em " + fmt(dados.respostasComTokens) + (dados.respostasComTokens === 1 ? " resposta medida" : " respostas medidas");
  }

  // ---------- Gráficos (Chart.js) ----------
  function opcoesBase(rotuloTooltip) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: { label: (ctx) => fmt(ctx.parsed.y) + " " + rotuloTooltip },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: CORES.grade },
          ticks: { color: CORES.texto, maxRotation: 0, autoSkip: true, maxTicksLimit: 10, font: { size: 11 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: CORES.grade },
          border: { display: false },
          ticks: { color: CORES.texto, precision: 0, maxTicksLimit: 5, font: { size: 11 }, callback: (v) => fmt(v) },
        },
      },
    };
  }

  function barras(cor, valores) {
    return {
      data: valores,
      backgroundColor: cor,
      hoverBackgroundColor: cor,
      borderRadius: 4,
      borderSkipped: "start",
      maxBarThickness: 22,
      categoryPercentage: 0.8,
      barPercentage: 0.9,
    };
  }

  function desenharOuAtualizar(nome, canvasId, rotulos, conjunto, rotuloTooltip) {
    if (graficos[nome]) {
      graficos[nome].data.labels = rotulos;
      Object.assign(graficos[nome].data.datasets[0], conjunto);
      graficos[nome].update();
      return;
    }
    graficos[nome] = new Chart($(canvasId), {
      type: "bar",
      data: { labels: rotulos, datasets: [conjunto] },
      options: opcoesBase(rotuloTooltip),
    });
  }

  function pintarGraficos() {
    if (typeof Chart === "undefined") {
      avisar("Não foi possível carregar o Chart.js. Os números dos cards continuam valendo.");
      return;
    }

    const dias = dados.tokensPorDia.map((d) => diaCurto(d.dia));
    desenharOuAtualizar(
      "tokens",
      "graficoTokens",
      dias,
      barras(CORES.tokens, dados.tokensPorDia.map((d) => d.tokens)),
      "tokens"
    );
    desenharOuAtualizar(
      "mensagens",
      "graficoMensagens",
      dias,
      barras(CORES.mensagens, dados.mensagensPorDia.map((d) => d.mensagens)),
      "mensagens"
    );

    const pico = dados.horarioDePico;
    desenharOuAtualizar(
      "horas",
      "graficoHoras",
      dados.porHora.map((h) => String(h.hora).padStart(2, "0") + "h"),
      {
        ...barras(CORES.horas, dados.porHora.map((h) => h.mensagens)),
        backgroundColor: dados.porHora.map((h) => (pico && h.hora === pico.hora ? CORES.pico : CORES.horas)),
      },
      "mensagens"
    );

    const ultimoDia = dados.tokensPorDia[dados.tokensPorDia.length - 1];
    $("resumo-tokens").textContent =
      fmt(ultimoDia ? ultimoDia.tokensAcumulados : 0) + " tokens nos últimos " + dados.periodo.dias + " dias";
    $("resumo-mensagens").textContent = "Pessoas e IA, últimos " + dados.periodo.dias + " dias";
    $("resumo-horas").textContent = pico
      ? "Pico às " + String(pico.hora).padStart(2, "0") + "h (" + fmt(pico.mensagens) + " mensagens)"
      : "Sem mensagens no período";
  }

  function pintarTabela() {
    const corpo = $("tabela-dias");
    corpo.textContent = "";
    dados.tokensPorDia
      .slice()
      .reverse()
      .forEach((d) => {
        const msg = dados.mensagensPorDia.find((m) => m.dia === d.dia) || { mensagens: 0, respostasIA: 0 };
        const linha = document.createElement("tr");
        [diaCurto(d.dia) + "/" + d.dia.slice(0, 4), fmt(d.tokens), fmt(d.tokensAcumulados), fmt(msg.mensagens), fmt(msg.respostasIA)].forEach(
          (valor, i) => {
            const celula = document.createElement(i === 0 ? "th" : "td");
            if (i === 0) celula.scope = "row";
            celula.textContent = valor;
            linha.appendChild(celula);
          }
        );
        corpo.appendChild(linha);
      });
  }

  function pintarTudo() {
    pintarCards();
    pintarGraficos();
    pintarTabela();
    marcarCarregando(false);
    const hora = new Date().toLocaleTimeString("pt-BR");
    atualizadoEm.textContent = "Atualizado às " + hora;
    $("painel-rodape").textContent =
      "Dias e horas no fuso " + dados.periodo.fusoHorario + ". Tokens informados pelo Google (usageMetadata) em cada resposta do Gemini.";
  }

  // ---------- Dados da API ----------
  async function carregar({ silencioso = false } = {}) {
    if (carregando || negado) return;
    carregando = true;
    clearTimeout(timerSincronizar);
    if (!silencioso) marcarCarregando(true);
    botaoAtualizar.disabled = true;

    try {
      // chamarApi envia "Authorization: Bearer <token_saas>"; 401 já volta para o login
      const resposta = await chamarApi("/api/analytics/tokens?dias=" + periodo);
      dados = resposta;
      geradoEm = new Date(resposta.geradoEm);
      avisar("");
      pintarTudo();
      return true;
    } catch (erro) {
      if (erro.status === 403) {
        mostrarAcessoNegado("Sua conta não tem permissão de administrador. " + erro.message);
      } else {
        marcarCarregando(false);
        avisar("Não foi possível carregar as métricas: " + erro.message + " Tente “Atualizar”.");
        atualizadoEm.textContent = "Falha ao atualizar";
      }
      return false;
    } finally {
      carregando = false;
      botaoAtualizar.disabled = false;
    }
  }

  // Depois de eventos ao vivo, confirma os números com a API (fonte da verdade)
  function agendarSincronizacao(ms) {
    clearTimeout(timerSincronizar);
    timerSincronizar = setTimeout(() => carregar({ silencioso: true }), ms);
  }

  // ---------- Tempo real ----------
  function aplicarGasto(quantidade, detalhes) {
    if (!dados || !Number.isInteger(quantidade) || quantidade <= 0 || !detalhes || !detalhes.mensagemId) return;
    if (vistos.has(detalhes.mensagemId)) return; // o mesmo evento não conta duas vezes
    vistos.add(detalhes.mensagemId);
    if (geradoEm && new Date(detalhes.createdAt) <= geradoEm) return; // a API já contou esta mensagem

    dados.totalTokens += quantidade;
    dados.totalMensagens += 1; // a resposta da IA também é uma mensagem
    dados.totalRespostasIA += 1;
    dados.respostasComTokens += 1;
    dados.mediaTokensPorResposta = Math.round((dados.totalTokens / dados.respostasComTokens) * 10) / 10;
    dados.ultimos7Dias.tokens += quantidade;
    dados.ultimos7Dias.mensagens += 1;
    dados.ultimos30Dias.tokens += quantidade;
    dados.ultimos30Dias.mensagens += 1;

    const indice = dados.tokensPorDia.findIndex((d) => d.dia === detalhes.dia);
    if (indice === -1) {
      // Virou o dia ou o período não inclui a data: pede os números de novo
      agendarSincronizacao(500);
    } else {
      dados.tokensPorDia[indice].tokens += quantidade;
      dados.tokensPorDia.slice(indice).forEach((d) => (d.tokensAcumulados += quantidade));
      dados.mensagensPorDia[indice].mensagens += 1;
      dados.mensagensPorDia[indice].respostasIA += 1;
    }
    const hora = dados.porHora[detalhes.hora];
    if (hora) {
      hora.mensagens += 1;
      hora.tokens += quantidade;
    }

    pintarTudo();
    const card = $("card-tokens");
    card.classList.remove("pulso");
    void card.offsetWidth; // reinicia a animação
    card.classList.add("pulso");
    agendarSincronizacao(5000);
  }

  function conectarTempoReal() {
    if (typeof io !== "function") {
      estadoAoVivo("erro", "Sem tempo real");
      return;
    }

    socket = io(SOCKET_URL, {
      // painel: 'admin' -> o servidor não conta esta aba como pessoa online no chat
      auth: (cb) => cb({ token: Sessao.token(), painel: "admin" }),
      transports: ["websocket", "polling"],
      reconnectionDelayMax: 10000,
    });

    socket.on("connect", () => {
      estadoAoVivo("conectando", "Validando acesso…");
      // O servidor confere o role no banco antes de colocar este socket na sala "admins"
      socket.timeout(8000).emit("entrarPainelAdmin", (erroTempo, resposta) => {
        if (erroTempo) {
          estadoAoVivo("erro", "Sem tempo real");
          return;
        }
        if (!resposta || !resposta.ok) {
          if (resposta && resposta.status === 403) mostrarAcessoNegado(resposta.erro);
          else estadoAoVivo("erro", "Sem tempo real");
          return;
        }
        estadoAoVivo("conectado", "Ao vivo");
        // Reconexão: sincroniza com a API (o que chegou enquanto estava fora entra aqui)
        carregar({ silencioso: true });
      });
    });

    socket.on("connect_error", (erro) => {
      const codigo = erro && erro.data && erro.data.codigo;
      if (codigo === "TOKEN_INVALIDO" || codigo === "TOKEN_EXPIRADO" || codigo === "USUARIO_INEXISTENTE") {
        Sessao.limpar();
        sessionStorage.setItem("motivoSaida", erro.message);
        window.location.replace("index.html");
        return;
      }
      estadoAoVivo("erro", "Sem conexão");
      if (!socket.active) setTimeout(() => socket.connect(), 5000);
    });

    socket.on("disconnect", (motivo) => {
      if (motivo === "io client disconnect" || negado) return;
      estadoAoVivo("reconectando", "Reconectando…");
      if (motivo === "io server disconnect") socket.connect();
    });

    socket.on("novoGastoDeToken", aplicarGasto);
    socket.on("painelAdminNegado", (d) => mostrarAcessoNegado(d && d.erro));
    socket.on("sessaoExpirada", (d) => {
      Sessao.limpar();
      sessionStorage.setItem("motivoSaida", (d && d.erro) || "Sessão expirada.");
      window.location.replace("index.html");
    });
  }

  // ---------- Controles ----------
  function marcarPeriodo() {
    botoesPeriodo.forEach((b) => {
      const ativo = Number(b.dataset.dias) === periodo;
      b.classList.toggle("ativo", ativo);
      b.setAttribute("aria-pressed", String(ativo));
    });
  }

  botoesPeriodo.forEach((botao) =>
    botao.addEventListener("click", () => {
      periodo = Number(botao.dataset.dias);
      try {
        localStorage.setItem("painelPeriodo", String(periodo));
      } catch {
        /* sem localStorage */
      }
      marcarPeriodo();
      carregar();
    })
  );

  botaoAtualizar.addEventListener("click", () => carregar());

  $("sair").addEventListener("click", () => {
    if (socket) socket.disconnect();
    Sessao.limpar();
    window.location.replace("index.html");
  });

  // Confere com a API de tempos em tempos (cobre mensagens humanas, que não geram evento)
  setInterval(() => {
    if (!document.hidden) carregar({ silencioso: true });
  }, 60000);

  // ---------- Início ----------
  const canvasTokens = $("graficoTokens");
  canvasTokens.setAttribute("role", "img");
  canvasTokens.setAttribute("aria-label", "Tokens consumidos por dia");

  marcarPeriodo();
  carregar().then((ok) => {
    if (ok) conectarTempoReal();
  });
})();
