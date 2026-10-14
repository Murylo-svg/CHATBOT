/**
 * Sala publica em tempo real (Socket.io).
 *
 * Eventos recebidos do cliente:
 *   novaMensagem      { texto, clientId, imagem?: { dados: ArrayBuffer }, debate?: { turnos, intervalo } }  (+ ack)
 *                     texto "@debate tema" abre um debate Gemini x Mistral; "@parar" encerra
 *   pararDebate       (+ ack) encerra o debate em andamento
 *
 * Eventos emitidos pelo servidor:
 *   mensagemRecebida   mensagem serializada (humana ou do 🤖 Moderador Gemini) para TODOS
 *   usuariosOnline     { total, conexoes, nomes } sempre que alguem entra ou sai
 *   moderadorDigitando { ativo } enquanto o Gemini gera uma resposta
 *   iaDigitando        { ativo, bot, nome } durante o debate entre IAs
 *   debateEstado       { ativo, tema, turno, total, intervalo, falando, proximaEm, motivo? }
 *   mensagensRemovidas { ids } quando alguem limpa o proprio historico (via REST)
 *   erroChat           { erro } apenas para quem causou o erro
 *   sessaoExpirada     { erro } antes de derrubar uma conexao com JWT vencido
 */
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const Usuario = require('../models/User');
const { validarToken } = require('../middleware/auth');
const { verificarOrigem, origemPermitida } = require('../config/cors');
const { enviarImagem } = require('../services/cloudinary');
const sala = require('../services/salaPublica');
const { criarGerenciadorDebate, ErroDebate, REGEX_DEBATE, REGEX_PARAR } = require('../services/debate');

// Limite de mensagens por usuario (todas as abas somadas)
const JANELA_RATE_MS = 10_000;
const MAX_MENSAGENS_JANELA = 8;
// Quantas respostas do Gemini podem estar em andamento ao mesmo tempo no servidor
const MAX_GEMINI_SIMULTANEAS = Number(process.env.GEMINI_MAX_SIMULTANEAS) || 3;

function erroDeConexao(mensagem, codigo) {
  const erro = new Error(mensagem);
  erro.data = { codigo };
  return erro;
}

function configurarSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: verificarOrigem, methods: ['GET', 'POST'] },
    // WebSocket nao passa pelo CORS do navegador: barramos a origem aqui tambem
    allowRequest: (req, callback) => callback(null, origemPermitida(req.headers.origin)),
    // 5 MB de imagem + folga para o envelope do pacote
    maxHttpBufferSize: 6 * 1024 * 1024,
  });

  // ---------- Estado em memoria (um processo no Render) ----------
  const online = new Map(); // usuarioId -> { nome, sockets: Set<socketId> }
  const historicoEnvios = new Map(); // usuarioId -> [timestamps]
  const emProcessamento = new Set(); // `${usuarioId}:${clientId}` sendo gravados agora
  const geminiPorUsuario = new Set(); // usuarios com pergunta ao Gemini em andamento
  let geminiAtivas = 0;
  const debate = criarGerenciadorDebate(io);

  function emitirOnline() {
    let conexoes = 0;
    const nomes = [];
    for (const { nome, sockets } of online.values()) {
      conexoes += sockets.size;
      nomes.push(nome);
    }
    io.emit('usuariosOnline', { total: online.size, conexoes, nomes: nomes.sort() });
  }

  function registrarOnline(socket) {
    const { id, nome } = socket.data.usuario;
    const registro = online.get(id) || { nome, sockets: new Set() };
    registro.nome = nome;
    registro.sockets.add(socket.id); // Set: a mesma conexao nunca conta duas vezes
    online.set(id, registro);
    emitirOnline();
  }

  function removerOnline(socket) {
    const { id } = socket.data.usuario;
    const registro = online.get(id);
    if (!registro || !registro.sockets.delete(socket.id)) return;
    if (registro.sockets.size === 0) online.delete(id);
    emitirOnline();
    // Ninguem assistindo: nao gasta cota das IAs
    if (online.size === 0) debate.parar('Debate encerrado: todos sairam da sala.');
  }

  function excedeuLimite(usuarioId) {
    const agora = Date.now();
    const recentes = (historicoEnvios.get(usuarioId) || []).filter((t) => agora - t < JANELA_RATE_MS);
    if (recentes.length >= MAX_MENSAGENS_JANELA) {
      historicoEnvios.set(usuarioId, recentes);
      return true;
    }
    recentes.push(agora);
    historicoEnvios.set(usuarioId, recentes);
    return false;
  }

  function sessaoValida(socket) {
    const exp = socket.data.exp;
    if (exp && exp * 1000 <= Date.now()) {
      socket.emit('sessaoExpirada', { erro: 'Sessao expirada. Faca login novamente.' });
      socket.disconnect(true);
      return false;
    }
    return true;
  }

  // ---------- Autenticacao no handshake ----------
  io.use(async (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    let payload;
    try {
      payload = validarToken(token);
    } catch (erro) {
      if (erro.name === 'TokenExpiredError') {
        return next(erroDeConexao('Sessao expirada. Faca login novamente.', 'TOKEN_EXPIRADO'));
      }
      return next(erroDeConexao(token ? 'Token invalido.' : 'Token nao enviado.', 'TOKEN_INVALIDO'));
    }

    if (!mongoose.isValidObjectId(payload.id)) {
      return next(erroDeConexao('Token invalido.', 'TOKEN_INVALIDO'));
    }

    try {
      // O nome exibido vem do banco, nunca do cliente nem do que estiver no navegador
      const usuario = await Usuario.findById(payload.id).select('nome').lean();
      if (!usuario) return next(erroDeConexao('Usuario nao encontrado.', 'USUARIO_INEXISTENTE'));

      socket.data.usuario = { id: String(usuario._id), nome: usuario.nome };
      socket.data.exp = payload.exp || null;
      return next();
    } catch (erro) {
      console.error('[socket] falha ao consultar usuario:', erro.message);
      return next(erroDeConexao('Servidor indisponivel. Tentando novamente...', 'ERRO_SERVIDOR'));
    }
  });

  // ---------- Resposta do Gemini (fora do fluxo do envio) ----------
  async function acionarModerador(socket, gatilho, imagem) {
    const usuarioId = socket.data.usuario.id;

    if (geminiPorUsuario.has(usuarioId)) {
      socket.emit('erroChat', { erro: 'Aguarde o Moderador Gemini terminar sua pergunta anterior.' });
      return;
    }
    if (geminiAtivas >= MAX_GEMINI_SIMULTANEAS) {
      socket.emit('erroChat', { erro: 'O Moderador Gemini esta ocupado. Tente mencionar de novo em instantes.' });
      return;
    }

    geminiPorUsuario.add(usuarioId);
    geminiAtivas += 1;
    io.emit('moderadorDigitando', { ativo: true });

    try {
      const resposta = await sala.gerarRespostaModerador(gatilho, imagem);
      io.emit('mensagemRecebida', sala.serializar(resposta));
    } catch (erro) {
      console.error('[socket] Gemini falhou:', erro.message);
      socket.emit('erroChat', { erro: 'O Moderador Gemini nao conseguiu responder agora: ' + erro.message });
    } finally {
      geminiPorUsuario.delete(usuarioId);
      geminiAtivas -= 1;
      io.emit('moderadorDigitando', { ativo: geminiAtivas > 0 });
    }
  }

  // ---------- Conexao autenticada ----------
  io.on('connection', (socket) => {
    const usuario = socket.data.usuario;
    registrarOnline(socket);
    if (debate.ativo()) socket.emit('debateEstado', debate.estadoPublico());

    // Derruba a conexao quando o JWT vencer, mesmo que o usuario fique parado
    let timerExpiracao = null;
    if (socket.data.exp) {
      const restante = socket.data.exp * 1000 - Date.now();
      timerExpiracao = setTimeout(() => sessaoValida(socket), Math.min(Math.max(restante, 0), 2 ** 31 - 1));
    }

    socket.on('novaMensagem', async (dados, ack) => {
      const responder = typeof ack === 'function' ? ack : () => {};
      let chave = null;

      try {
        if (!sessaoValida(socket)) return;
        if (!dados || typeof dados !== 'object') throw new sala.ErroValidacao('Mensagem invalida.');

        const texto = sala.validarTexto(dados.texto);
        const clientId = sala.validarClientId(dados.clientId);
        const imagem = sala.validarImagem(dados.imagem);

        if (!texto && !imagem) throw new sala.ErroValidacao('Mensagem vazia. Escreva algo ou envie uma imagem.');

        // Reenvio do mesmo clientId (ex.: reconexao): devolve a ja gravada, sem duplicar
        if (clientId) {
          chave = `${usuario.id}:${clientId}`;
          const existente = await sala.buscarDuplicada(usuario.id, clientId);
          if (existente) {
            chave = null;
            return responder({ ok: true, duplicada: true, mensagem: sala.serializar(existente) });
          }
          if (emProcessamento.has(chave)) {
            chave = null;
            return responder({ ok: false, emProcessamento: true, erro: 'Mensagem ainda sendo enviada.' });
          }
          emProcessamento.add(chave);
        }

        if (excedeuLimite(usuario.id)) {
          throw new sala.ErroValidacao('Voce esta enviando mensagens rapido demais. Aguarde alguns segundos.');
        }

        // Comandos de debate. O inicio e validado ANTES de gravar a mensagem.
        const comandoDebate = !imagem && texto.match(REGEX_DEBATE);
        const comandoParar = !imagem && REGEX_PARAR.test(texto);
        const configDebate = comandoDebate ? debate.validarInicio(comandoDebate[1], dados.debate || {}) : null;

        const imagemUrl = imagem ? await enviarImagem(imagem.buffer, usuario.id) : null;

        const { mensagem, duplicada } = await sala.salvarMensagemHumana({
          usuario,
          texto,
          imagemUrl,
          clientId,
        });
        const publica = sala.serializar(mensagem);

        if (!duplicada) io.emit('mensagemRecebida', publica);
        responder({ ok: true, duplicada, mensagem: publica });

        if (duplicada) return;

        if (configDebate) {
          if (debate.ativo()) socket.emit('erroChat', { erro: 'Outro debate comecou antes do seu. Tente quando ele acabar.' });
          else debate.iniciar(mensagem, usuario, configDebate);
          return;
        }
        if (comandoParar) {
          if (!debate.parar(`${usuario.nome} parou o debate.`)) socket.emit('erroChat', { erro: 'Nao ha debate em andamento.' });
          return;
        }

        // So mensagens humanas novas com @gemini/@bot acionam a IA.
        // Respostas do bot nunca passam por aqui, entao nao ha loop bot -> bot.
        if (sala.mencionaBot(texto)) {
          acionarModerador(socket, mensagem, imagem);
        }
      } catch (erro) {
        const esperado = erro instanceof sala.ErroValidacao || erro instanceof ErroDebate;
        if (!esperado) console.error('[socket] novaMensagem:', erro.message);
        responder({ ok: false, erro: esperado ? erro.message : 'Nao foi possivel enviar a mensagem. Tente novamente.' });
      } finally {
        if (chave) emProcessamento.delete(chave);
      }
    });

    socket.on('pararDebate', (ack) => {
      const responder = typeof ack === 'function' ? ack : () => {};
      if (!sessaoValida(socket)) return;
      const parou = debate.parar(`${usuario.nome} parou o debate.`);
      responder(parou ? { ok: true } : { ok: false, erro: 'Nao ha debate em andamento.' });
    });

    socket.on('disconnect', () => {
      clearTimeout(timerExpiracao);
      removerOnline(socket);
    });
  });

  return io;
}

module.exports = configurarSocket;
