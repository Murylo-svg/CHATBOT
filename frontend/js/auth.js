/* Tela de entrada: alterna entre login e cadastro. */

(function () {
  // Já logado? Vai direto para o chat.
  if (Sessao.logada()) {
    window.location.replace("chat.html");
    return;
  }

  const abas = document.querySelectorAll(".abas button");
  const formulario = document.getElementById("formulario");
  const campoNome = document.getElementById("campo-nome");
  const nome = document.getElementById("nome");
  const email = document.getElementById("email");
  const senha = document.getElementById("senha");
  const botao = document.getElementById("enviar");
  const aviso = document.getElementById("aviso");

  let modo = "login";

  function mostrar(texto, tipo) {
    aviso.textContent = texto;
    aviso.className = "aviso " + tipo;
  }

  function esconder() {
    aviso.className = "aviso";
  }

  // Mensagem vinda de uma sessão derrubada
  const motivoSaida = sessionStorage.getItem("motivoSaida");
  if (motivoSaida) {
    mostrar(motivoSaida, "erro");
    sessionStorage.removeItem("motivoSaida");
  }

  abas.forEach((aba) => {
    aba.addEventListener("click", () => {
      modo = aba.dataset.aba;
      abas.forEach((b) => b.classList.toggle("ativa", b === aba));

      const ehCadastro = modo === "cadastro";
      campoNome.hidden = !ehCadastro;
      nome.required = ehCadastro;
      senha.autocomplete = ehCadastro ? "new-password" : "current-password";
      botao.textContent = ehCadastro ? "Criar conta" : "Entrar";
      esconder();
    });
  });

  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    esconder();

    if (modo === "cadastro" && nome.value.trim().length < 2) {
      return mostrar("Informe seu nome.", "erro");
    }
    if (!email.value.includes("@")) {
      return mostrar("Informe um e-mail válido.", "erro");
    }
    if (senha.value.length < 6) {
      return mostrar("A senha precisa ter pelo menos 6 caracteres.", "erro");
    }

    botao.disabled = true;
    botao.textContent = modo === "cadastro" ? "Criando conta..." : "Entrando...";

    try {
      const corpo =
        modo === "cadastro"
          ? { nome: nome.value.trim(), email: email.value.trim(), senha: senha.value }
          : { email: email.value.trim(), senha: senha.value };

      const dados = await chamarApi("/api/auth/" + (modo === "cadastro" ? "register" : "login"), {
        method: "POST",
        body: JSON.stringify(corpo),
      });

      Sessao.salvar(dados.token, dados.usuario);
      window.location.replace("chat.html");
    } catch (erro) {
      mostrar(erro.message, "erro");
      botao.disabled = false;
      botao.textContent = modo === "cadastro" ? "Criar conta" : "Entrar";
    }
  });
})();
