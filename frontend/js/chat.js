/* Tela de chat: sala pública em tempo real (Socket.io), histórico, imagens e Moderador Gemini. */

(function () {
  // ---------- Guarda de rota ----------
  if (!Sessao.logada()) {
    window.location.replace("index.html");
    return;
  }

  const conversa = document.getElementById("conversa");
  const texto = document.getElementById("texto");
  const enviar = document.getElementById("enviar");
  const anexar = document.getElementById("anexar");
  const arquivo = document.getElementById("arquivo");
  const previa = document.getElementById("previa");
  const previaImagem = document.getElementById("previa-imagem");
  const previaNome = document.getElementById("previa-nome");
  const previaRemover = document.getElementById("previa-remover");
  const limpar = document.getElementById("limpar");
  const sair = document.getElementById("sair");
  const quem = document.getElementById("quem");
  const conexao = document.getElementById("conexao");
  const online = document.getElementById("online");
  const onlineTotal = document.getElementById("online-total");
  const avisoChat = document.getElementById("aviso-chat");
  const abrirDebate = document.getElementById("abrir-debate");
  const dialogoDebate = document.getElementById("dialogo-debate");
  const formDebate = document.getElementById("form-debate");
  const campoTemaDebate = document.getElementById("debate-tema-campo");
  const campoTurnos = document.getElementById("debate-turnos");
  const campoIntervalo = document.getElementById("debate-intervalo");
  const cancelarDebate = document.getElementById("cancelar-debate");
  const painelDebate = document.getElementById("painel-debate");
  const debateTema = document.getElementById("debate-tema");
  const debateInfo = document.getElementById("debate-info");
  const pararDebate = document.getElementById("parar-debate");

  const LIMITE_TEXTO = 2000;
  const LIMITE_IMAGEM = 5 * 1024 * 1024;
  const TEMPO_ACK_MS = 30000; // upload de imagem + gravação no banco

  const usuario = Sessao.usuario();
  quem.textContent = usuario ? usuario.nome + " · " + usuario.email : "";

  let imagemSelecionada = null;
  let enviando = false;
  let historicoPronto = false;
  let filaAoVivo = []; // mensagens que chegaram enquanto o histórico carregava
  let socket = null;

  const renderizadas = new Map(); // _id -> elemento (impede duplicadas)
  const pendentes = new Map(); // clientId -> { elemento, payload }

  // ---------- Avisos e estado da conexão ----------
  let timerAviso = null;
  function avisar(mensagem, tipo = "erro", duracao = 6000) {
    avisoChat.textContent = mensagem;
    avisoChat.className = "aviso-chat " + tipo;
    avisoChat.hidden = false;
    clearTimeout(timerAviso);
    if (duracao) timerAviso = setTimeout(() => (avisoChat.hidden = true), duracao);
  }

  function estadoConexao(classe, rotulo) {
    conexao.className = "conexao " + classe;
    conexao.textContent = rotulo;
    atualizarBotao();
  }

  function atualizarBotao() {
    enviar.disabled = enviando || !socket || !socket.connected;
  }

  function encerrarSessao(motivo) {
    Sessao.limpar();
    sessionStorage.setItem("motivoSaida", motivo || "Sessão expirada. Faça login novamente.");
    if (socket) socket.disconnect();
    window.location.replace("index.html");
  }

  // ---------- Desenho das mensagens ----------
  function estadoVazio() {
    conversa.innerHTML =
      '<div class="vazio">' +
      "<h2>A sala está quieta</h2>" +
      "<p>Mande um oi para quem estiver online. Escreva <strong>@gemini</strong> ou <strong>@bot</strong> para chamar o Moderador Gemini: ele vê imagens, lembra da conversa e consulta o clima em tempo real.</p>" +
      "</div>";
  }

  // Qualquer IA que não seja o Gemini principal (Gemini 2, Mistral; "llama" = falas antigas)
  function ehSegundaIA(bot) {
    return Boolean(bot) && bot !== "gemini";
  }

  function ehMinha(mensagem) {
    return mensagem.autor === "user" && usuario && String(mensagem.usuario) === String(usuario._id);
  }

  function urlSegura(url) {
    return typeof url === "string" && (url.startsWith("https://") || url.startsWith("blob:"));
  }

  function formatarHora(data) {
    const d = data ? new Date(data) : new Date();
    return isNaN(d) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function criarBalao(mensagem) {
    const bot = mensagem.autor === "model";
    const balao = document.createElement("div");
    // de-usuario = minha | de-outro = outra pessoa | de-ia de-bot = IA (de-segunda-ia = Gemini 2 / Mistral)
    balao.className =
      "balao " +
      (bot ? "de-ia de-bot" + (ehSegundaIA(mensagem.bot) ? " de-segunda-ia" : "") : ehMinha(mensagem) ? "de-usuario" : "de-outro");

    // Nome sempre vindo do servidor (nomeAutor), nunca digitado pelo cliente
    const cabecalho = document.createElement("div");
    cabecalho.className = "remetente";
    const nome = document.createElement("span");
    nome.className = "nome";
    nome.textContent = ehMinha(mensagem) ? "Você" : mensagem.nomeAutor || "Usuário";
    const hora = document.createElement("span");
    hora.className = "hora";
    hora.textContent = formatarHora(mensagem.createdAt);
    cabecalho.append(nome, hora);
    balao.appendChild(cabecalho);

    if (urlSegura(mensagem.imagemUrl)) {
      const img = document.createElement("img");
      img.src = mensagem.imagemUrl;
      img.alt = "Imagem enviada por " + (mensagem.nomeAutor || "usuário");
      img.loading = "lazy";
      balao.appendChild(img);
    }

    if (mensagem.texto) {
      const corpo = document.createElement("div");
      corpo.className = "corpo";
      corpo.textContent = mensagem.texto;
      balao.appendChild(corpo);
    }

    if (mensagem.ferramentaUsada) {
      const etiqueta = document.createElement("span");
      etiqueta.className = "etiqueta-ferramenta";
      etiqueta.textContent = "consultou dados em tempo real";
      balao.appendChild(etiqueta);
    }

    return balao;
  }

  function pertoDoFim() {
    return conversa.scrollHeight - conversa.scrollTop - conversa.clientHeight < 120;
  }

  function descer() {
    conversa.scrollTop = conversa.scrollHeight;
  }

  function inserir(elemento, forcarRolagem) {
    const vazio = conversa.querySelector(".vazio");
    if (vazio) vazio.remove();
    const rolar = forcarRolagem || pertoDoFim();
    // O indicador "digitando" fica sempre por último
    const digitando = conversa.querySelector(".digitando");
    conversa.insertBefore(elemento, digitando || null);
    if (rolar) descer();
  }

  /** Adiciona uma mensagem confirmada pelo servidor, sem nunca repetir. */
  function adicionar(mensagem) {
    if (!mensagem || !mensagem._id || renderizadas.has(mensagem._id)) return;

    const balao = criarBalao(mensagem);
    balao.dataset.id = mensagem._id;
    renderizadas.set(mensagem._id, balao);

    // Era uma mensagem minha mostrada de forma otimista? Troca pelo balão definitivo.
    const pendente = mensagem.clientId && pendentes.get(mensagem.clientId);
    if (pendente) {
      pendentes.delete(mensagem.clientId);
      if (pendente.elemento.isConnected) {
        pendente.elemento.replaceWith(balao);
        if (pendente.urlLocal) URL.revokeObjectURL(pendente.urlLocal);
        return;
      }
    }
    inserir(balao, ehMinha(mensagem));
  }

  function remover(ids) {
    ids.forEach((id) => {
      const elemento = renderizadas.get(id);
      if (elemento) elemento.remove();
      renderizadas.delete(id);
    });
    if (!conversa.querySelector(".balao")) estadoVazio();
  }

  // chave: "moderador" (resposta a @gemini/@bot) ou "debate" (debate entre IAs)
  function mostrarDigitando(ativo, nome = "🤖 Moderador Gemini", chave = "moderador", segundaIA = false) {
    let bloco = document.getElementById("digitando-" + chave);
    if (!ativo) {
      if (bloco) bloco.remove();
      return;
    }
    if (bloco) bloco.remove();
    bloco = document.createElement("div");
    bloco.className = "digitando" + (segundaIA ? " de-segunda-ia" : "");
    bloco.id = "digitando-" + chave;
    bloco.title = nome + " está escrevendo";
    const rotulo = document.createElement("em");
    rotulo.textContent = nome;
    bloco.append(rotulo, document.createElement("span"), document.createElement("span"), document.createElement("span"));
    const rolar = pertoDoFim();
    conversa.appendChild(bloco);
    if (rolar) descer();
  }

  // ---------- Histórico inicial (REST) ----------
  // Também roda a cada reconexão: traz o que chegou enquanto estávamos fora.
  async function sincronizarHistorico() {
    try {
      const dados = await chamarApi("/api/chat/sala");
      if (!historicoPronto) {
        conversa.innerHTML = "";
        renderizadas.clear();
      }
      dados.mensagens.forEach(adicionar);
      historicoPronto = true;

      filaAoVivo.forEach(adicionar);
      filaAoVivo = [];

      if (!conversa.querySelector(".balao")) estadoVazio();
      descer();
    } catch (erro) {
      if (!historicoPronto) {
        conversa.innerHTML = "";
        const bloco = document.createElement("div");
        bloco.className = "vazio";
        const titulo = document.createElement("h2");
        titulo.textContent = "Não foi possível carregar";
        const p = document.createElement("p");
        p.textContent = erro.message;
        bloco.append(titulo, p);
        conversa.appendChild(bloco);
      } else {
        avisar("Não foi possível atualizar o histórico: " + erro.message);
      }
    }
  }

  // ---------- Conexão em tempo real ----------
  if (typeof io !== "function") {
    estadoConexao("erro", "Sem tempo real");
    avisar("Não foi possível carregar o cliente Socket.io. Recarregue a página.", "erro", 0);
    sincronizarHistorico();
    return;
  }

  socket = io(SOCKET_URL, {
    // Função: a cada (re)conexão lê o token atual do localStorage (chave token_saas)
    auth: (cb) => cb({ token: Sessao.token() }),
    transports: ["websocket", "polling"],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  let tentativaManual = null;

  socket.on("connect", () => {
    clearTimeout(tentativaManual);
    estadoConexao("conectado", "Conectado");
    avisoChat.hidden = true;
    sincronizarHistorico();
    reenviarPendentes();
  });

  socket.on("connect_error", (erro) => {
    const codigo = erro && erro.data && erro.data.codigo;
    if (codigo === "TOKEN_INVALIDO" || codigo === "TOKEN_EXPIRADO" || codigo === "USUARIO_INEXISTENTE") {
      encerrarSessao(erro.message);
      return;
    }
    estadoConexao("erro", "Sem conexão");
    // Recusa do middleware desliga a reconexão automática: tentamos de novo manualmente
    if (!socket.active) {
      clearTimeout(tentativaManual);
      tentativaManual = setTimeout(() => socket.connect(), 5000);
    }
  });

  socket.on("disconnect", (motivo) => {
    if (motivo === "io client disconnect") return;
    estadoConexao("reconectando", "Reconectando…");
    mostrarDigitando(false);
    if (motivo === "io server disconnect") {
      // O servidor derrubou (ex.: token vencido). Tenta uma vez; o handshake decide.
      socket.connect();
    }
  });

  socket.io.on("reconnect_attempt", (n) => estadoConexao("reconectando", "Reconectando… (" + n + ")"));

  socket.on("mensagemRecebida", (mensagem) => {
    if (!historicoPronto) {
      filaAoVivo.push(mensagem);
      return;
    }
    adicionar(mensagem);
  });

  socket.on("mensagensRemovidas", (dados) => {
    if (dados && Array.isArray(dados.ids)) remover(dados.ids);
  });

  socket.on("usuariosOnline", (dados) => {
    onlineTotal.textContent = dados.total;
    online.title = dados.nomes && dados.nomes.length
      ? "Online agora: " + dados.nomes.join(", ") + " (" + dados.conexoes + " conexões)"
      : "Ninguém online";
  });

  socket.on("moderadorDigitando", (dados) => mostrarDigitando(Boolean(dados && dados.ativo)));

  socket.on("iaDigitando", (dados) =>
    mostrarDigitando(Boolean(dados && dados.ativo), dados && dados.nome, "debate", dados && ehSegundaIA(dados.bot))
  );

  // ---------- Debate entre IAs ----------
  let timerDebate = null;

  function atualizarPainelDebate(estado) {
    clearInterval(timerDebate);
    if (!estado || !estado.ativo) {
      painelDebate.hidden = true;
      mostrarDigitando(false, "", "debate");
      if (estado && estado.motivo) avisar(estado.motivo, "info", 8000);
      return;
    }

    painelDebate.hidden = false;
    debateTema.textContent = "“" + estado.tema + "” · por " + estado.iniciadoPor;

    const pintar = () => {
      const fala = "Fala " + Math.min(estado.turno + 1, estado.total) + " de " + estado.total;
      const faltam = estado.proximaEm ? Math.ceil((estado.proximaEm - Date.now()) / 1000) : 0;
      const quem = estado.nomeFalando || "Próxima IA";
      if (estado.aviso) {
        debateInfo.textContent = "⏳ " + estado.aviso + (faltam > 0 ? " (" + faltam + "s)" : "");
        return;
      }
      debateInfo.textContent =
        fala + " · " + (faltam > 0 ? quem + " fala em " + faltam + "s" : quem + " está pensando…") +
        " · " + estado.intervalo + "s entre falas";
    };
    pintar();
    timerDebate = setInterval(pintar, 500);
  }

  socket.on("debateEstado", atualizarPainelDebate);

  abrirDebate.addEventListener("click", () => {
    if (!painelDebate.hidden) {
      avisar("Já tem um debate acontecendo. Pare o atual antes de começar outro.", "info", 4000);
      return;
    }
    if (typeof dialogoDebate.showModal === "function") dialogoDebate.showModal();
    else dialogoDebate.setAttribute("open", "");
    campoTemaDebate.focus();
  });

  cancelarDebate.addEventListener("click", () => dialogoDebate.close());

  formDebate.addEventListener("submit", (evento) => {
    evento.preventDefault();
    const tema = campoTemaDebate.value.replace(/\s+/g, " ").trim();
    if (tema.length < 3) {
      campoTemaDebate.focus();
      return;
    }
    dialogoDebate.close();
    campoTemaDebate.value = "";
    // Vira uma mensagem "@debate tema" na sala, assim todos veem quem começou
    enviarComando("@debate " + tema, {
      turnos: Number(campoTurnos.value),
      intervalo: Number(campoIntervalo.value),
    });
  });

  pararDebate.addEventListener("click", () => {
    pararDebate.disabled = true;
    socket.timeout(5000).emit("pararDebate", (erroTempo, resposta) => {
      pararDebate.disabled = false;
      if (erroTempo) return avisar("O servidor não respondeu. Tente de novo.");
      if (!resposta.ok) avisar(resposta.erro, "info", 4000);
    });
  });

  socket.on("erroChat", (dados) => avisar((dados && dados.erro) || "Erro no chat."));

  socket.on("sessaoExpirada", (dados) => encerrarSessao(dados && dados.erro));

  // ---------- Anexo de imagem ----------
  anexar.addEventListener("click", () => arquivo.click());

  arquivo.addEventListener("change", () => {
    const item = arquivo.files[0];
    if (!item) return;

    if (!item.type.startsWith("image/")) {
      avisar("Apenas arquivos de imagem são aceitos.");
      arquivo.value = "";
      return;
    }
    if (item.size > LIMITE_IMAGEM) {
      avisar("A imagem precisa ter no máximo 5 MB.");
      arquivo.value = "";
      return;
    }

    imagemSelecionada = item;
    previaImagem.src = URL.createObjectURL(item);
    previaNome.textContent = item.name;
    previa.classList.add("visivel");
  });

  previaRemover.addEventListener("click", limparAnexo);

  function limparAnexo() {
    imagemSelecionada = null;
    arquivo.value = "";
    previa.classList.remove("visivel");
  }

  // ---------- Envio ----------
  function novoClientId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  function marcarFalha(clientId, mensagemErro) {
    const pendente = pendentes.get(clientId);
    if (!pendente) return;
    const balao = pendente.elemento;
    balao.classList.add("falhou");
    balao.classList.remove("enviando");

    let rodape = balao.querySelector(".falha");
    if (!rodape) {
      rodape = document.createElement("div");
      rodape.className = "falha";
      balao.appendChild(rodape);
    }
    rodape.textContent = "Não enviada: " + mensagemErro + " ";

    const botao = document.createElement("button");
    botao.type = "button";
    botao.textContent = "Tentar de novo";
    botao.addEventListener("click", () => transmitir(clientId));
    rodape.appendChild(botao);
  }

  /** Envia (ou reenvia) uma mensagem pendente. O mesmo clientId nunca duplica no servidor. */
  function transmitir(clientId) {
    const pendente = pendentes.get(clientId);
    if (!pendente) return;

    if (!socket.connected) {
      marcarFalha(clientId, "sem conexão com o servidor.");
      return;
    }

    const tentativa = (pendente.tentativa = (pendente.tentativa || 0) + 1);
    pendente.elemento.classList.remove("falhou");
    pendente.elemento.classList.add("enviando");
    const falha = pendente.elemento.querySelector(".falha");
    if (falha) falha.remove();

    socket.timeout(TEMPO_ACK_MS).emit("novaMensagem", pendente.payload, (erroTempo, resposta) => {
      // Resposta de uma tentativa antiga (já houve reenvio): só vale se trouxer a confirmação
      if (tentativa !== pendente.tentativa) {
        if (resposta && resposta.ok) adicionar(resposta.mensagem);
        return;
      }
      if (erroTempo) return marcarFalha(clientId, "o servidor não confirmou a tempo.");
      if (!resposta || !resposta.ok) {
        if (resposta && resposta.emProcessamento) return; // a confirmação chega por mensagemRecebida
        avisar((resposta && resposta.erro) || "Não foi possível enviar.");
        return marcarFalha(clientId, (resposta && resposta.erro) || "erro desconhecido.");
      }
      // Confirma mesmo que o broadcast tenha se perdido numa reconexão
      adicionar(resposta.mensagem);
    });
  }

  // Após reconectar, reenvia o que ficou sem confirmação. O servidor reconhece o
  // clientId e devolve a mensagem já gravada em vez de gravar outra vez.
  function reenviarPendentes() {
    pendentes.forEach((pendente, clientId) => transmitir(clientId));
  }

  // Opções extras do próximo envio de "@debate" (vindas do formulário)
  let opcoesDebate = null;

  function enviarComando(comando, opcoes) {
    const rascunho = texto.value;
    texto.value = comando;
    opcoesDebate = opcoes || null;
    mandar().finally(() => {
      if (rascunho && !texto.value) texto.value = rascunho;
    });
  }

  async function mandar() {
    if (enviando) return;

    const conteudo = texto.value.trim();
    if (!conteudo && !imagemSelecionada) {
      avisar("Escreva uma mensagem ou escolha uma imagem.", "info", 3000);
      return;
    }
    if (conteudo.length > LIMITE_TEXTO) {
      avisar("A mensagem passou de " + LIMITE_TEXTO + " caracteres.");
      return;
    }
    if (!socket.connected) {
      avisar("Sem conexão com o servidor. Aguarde a reconexão para enviar.");
      return;
    }

    enviando = true;
    atualizarBotao();

    try {
      const clientId = novoClientId();
      const payload = { texto: conteudo, clientId };
      if (opcoesDebate && /^@debate\b/i.test(conteudo)) payload.debate = opcoesDebate;
      opcoesDebate = null;
      let urlLocal = null;

      if (imagemSelecionada) {
        payload.imagem = { dados: await imagemSelecionada.arrayBuffer() };
        urlLocal = URL.createObjectURL(imagemSelecionada);
      }

      // Mostra na hora (otimista); o balão é trocado quando o servidor confirmar
      const elemento = criarBalao({
        autor: "user",
        usuario: usuario && usuario._id,
        nomeAutor: usuario && usuario.nome,
        texto: conteudo,
        imagemUrl: urlLocal,
      });
      elemento.classList.add("enviando");
      pendentes.set(clientId, { elemento, payload, urlLocal });
      inserir(elemento, true);

      texto.value = "";
      texto.style.height = "auto";
      limparAnexo();

      transmitir(clientId);
    } catch (erro) {
      avisar("Não foi possível preparar a mensagem: " + erro.message);
    } finally {
      enviando = false;
      atualizarBotao();
      texto.focus();
    }
  }

  enviar.addEventListener("click", mandar);

  texto.addEventListener("keydown", (evento) => {
    if (evento.key === "Enter" && !evento.shiftKey) {
      evento.preventDefault();
      mandar();
    }
  });

  // Textarea cresce com o conteúdo
  texto.addEventListener("input", () => {
    texto.style.height = "auto";
    texto.style.height = Math.min(texto.scrollHeight, 140) + "px";
  });

  // ---------- Limpar histórico ----------
  limpar.addEventListener("click", async () => {
    if (!confirm("Apagar todas as SUAS mensagens (e as respostas do Gemini a você)? Isso remove do banco de dados para todos.")) return;

    try {
      const dados = await chamarApi("/api/chat/historico", { method: "DELETE" });
      // O servidor também avisa os outros por "mensagensRemovidas"; aqui garantimos a nossa tela
      const minhas = [];
      renderizadas.forEach((elemento, id) => {
        if (elemento.classList.contains("de-usuario")) minhas.push(id);
      });
      remover(minhas);
      avisar(dados.removidas + " mensagem(ns) apagada(s).", "sucesso", 3000);
    } catch (erro) {
      avisar("Não foi possível apagar: " + erro.message);
    }
  });

  // ---------- Sair ----------
  sair.addEventListener("click", () => {
    socket.disconnect();
    Sessao.limpar();
    window.location.replace("index.html");
  });

  estadoConexao("conectando", "Conectando…");
})();
