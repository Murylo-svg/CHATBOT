const mongoose = require('mongoose');

const mensagemSchema = new mongoose.Schema(
  {
    // Dono da mensagem. Nas respostas do Moderador Gemini na sala publica,
    // guarda quem mencionou o bot (assim a limpeza do historico leva junto a resposta).
    usuario: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Usuario',
      required: true,
      index: true,
    },
    // 'user' = escrito pela pessoa | 'model' = resposta da IA
    autor: {
      type: String,
      enum: ['user', 'model'],
      required: true,
    },
    texto: {
      type: String,
      default: '',
    },
    imagemUrl: {
      type: String,
      default: null,
    },
    // Guarda qual funcao externa a IA chamou, se chamou alguma
    ferramentaUsada: {
      type: String,
      default: null,
    },

    // ---------- Sala publica em tempo real (Sprint 7) ----------
    // null = conversa privada do endpoint REST antigo | 'publica' = sala via Socket.io
    sala: {
      type: String,
      default: null,
      index: true,
    },
    // Nome exibido, copiado do banco no momento do envio (nunca vem do cliente)
    nomeAutor: {
      type: String,
      default: null,
    },
    // Id gerado pelo navegador para cada envio. Torna o envio idempotente:
    // se o cliente reenviar apos uma reconexao, o servidor nao duplica.
    clientId: {
      type: String,
      default: undefined,
    },
    // Nas respostas do bot: a mensagem que o mencionou
    respostaA: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mensagem',
      default: null,
    },
  },
  { timestamps: true }
);

// Historico da sala em ordem cronologica
mensagemSchema.index({ sala: 1, createdAt: -1 });

// Um mesmo clientId (UUID aleatorio do navegador) nunca e gravado duas vezes.
// sparse: mensagens sem clientId (chat privado REST, respostas do bot) ficam fora do indice.
mensagemSchema.index({ clientId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Mensagem', mensagemSchema);
