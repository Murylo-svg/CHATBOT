const mongoose = require('mongoose');

const usuarioSchema = new mongoose.Schema(
  {
    nome: {
      type: String,
      required: [true, 'O nome e obrigatorio'],
      trim: true,
      minlength: 2,
      maxlength: 60,
    },
    email: {
      type: String,
      required: [true, 'O e-mail e obrigatorio'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail invalido'],
    },
    senhaHash: {
      type: String,
      required: true,
    },
    // RBAC: todo cadastro nasce como "user". So o banco (ou scripts/definirAdmin.js)
    // promove alguem a "admin"; nenhuma rota da API altera este campo.
    role: {
      type: String,
      default: "user",
      enum: ["user", "admin"],
    },
  },
  { timestamps: true }
);

// Nunca devolve o hash da senha em JSON
usuarioSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.senhaHash;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Usuario', usuarioSchema);
