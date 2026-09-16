/* Tela de chat: histórico, envio de mensagens e upload de imagem. */

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

  const usuario = Sessao.usuario();
  quem.textContent = usuario ? usuario.nome + " · " + usuario.email : "";

  let imagemSelecionada = null;
  let enviando = false;

  // ---------- Desenho das mensagens ----------
  function estadoVazio() {
    conversa.innerHTML =
      '<div class="vazio">' +
      "<h2>Comece a conversa</h2>" +
      "<p>Diga seu nome e pergunte depois se ele lembra. Envie a foto de uma fruta e pergunte a cor. Ou pergunte a temperatura em Tóquio agora.</p>" +
      "</div>";
  }

  function desenhar(mensagem) {
    const vazio = conversa.querySelector(".vazio");
    if (vazio) vazio.remove();

    const balao = document.createElement("div");
    balao.className = "balao " + (mensagem.autor === "user" ? "de-usuario" : "de-ia");

    if (mensagem.imagemUrl) {
      const img = document.createElement("img");
      img.src = mensagem.imagemUrl;
      img.alt = "Imagem enviada";
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

    conversa.appendChild(balao);
    descer();
    return balao;
  }

  function descer() {
    conversa.scrollTop = conversa.scrollHeight;
  }

  function mostrarDigitando() {
    const bloco = document.createElement("div");
    bloco.className = "digitando";
    bloco.id = "digitando";
    bloco.innerHTML = "<span></span><span></span><span></span>";
    conversa.appendChild(bloco);
    descer();
  }

  function esconderDigitando() {
    const bloco = document.getElementById("digitando");
    if (bloco) bloco.remove();
  }

  // ---------- Carregar histórico ----------
  async function carregar() {
    try {
      const dados = await chamarApi("/api/chat/historico");
      if (!dados.mensagens.length) return estadoVazio();
      conversa.innerHTML = "";
      dados.mensagens.forEach(desenhar);
    } catch (erro) {
      conversa.innerHTML =
        '<div class="vazio"><h2>Não foi possível carregar</h2><p>' + erro.message + "</p></div>";
    }
  }

  // ---------- Anexo de imagem ----------
  anexar.addEventListener("click", () => arquivo.click());

  arquivo.addEventListener("change", () => {
    const item = arquivo.files[0];
    if (!item) return;

    if (item.size > 5 * 1024 * 1024) {
      alert("A imagem precisa ter no máximo 5 MB.");
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
  async function mandar() {
    if (enviando) return;

    const conteudo = texto.value.trim();
    if (!conteudo && !imagemSelecionada) return;

    enviando = true;
    enviar.disabled = true;

    // Mostra a mensagem do usuário na hora, sem esperar o servidor
    desenhar({
      autor: "user",
      texto: conteudo,
      imagemUrl: imagemSelecionada ? URL.createObjectURL(imagemSelecionada) : null,
    });

    const formulario = new FormData();
    formulario.append("mensagem", conteudo);
    if (imagemSelecionada) formulario.append("imagem", imagemSelecionada);

    texto.value = "";
    texto.style.height = "auto";
    limparAnexo();
    mostrarDigitando();

    try {
      const dados = await chamarApi("/api/chat", { method: "POST", body: formulario });
      esconderDigitando();
      desenhar(dados.resposta);
    } catch (erro) {
      esconderDigitando();
      desenhar({ autor: "model", texto: "Erro: " + erro.message });
    } finally {
      enviando = false;
      enviar.disabled = false;
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
    if (!confirm("Apagar todas as mensagens? Isso remove o histórico do banco de dados.")) return;

    try {
      await chamarApi("/api/chat/historico", { method: "DELETE" });
      estadoVazio();
    } catch (erro) {
      alert("Não foi possível apagar: " + erro.message);
    }
  });

  // ---------- Sair ----------
  sair.addEventListener("click", () => {
    Sessao.limpar();
    window.location.replace("index.html");
  });

  carregar();
})();
