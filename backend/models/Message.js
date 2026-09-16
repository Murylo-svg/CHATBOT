const mongoose = require('mongoose');

const mensagemSchema = new mongoose.Schema(
  {
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Mensagem', mensagemSchema);
