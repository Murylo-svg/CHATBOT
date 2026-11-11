/**
 * Promove (ou rebaixa) UM usuario pelo e-mail. Nao mexe em mais ninguem.
 *
 *   npm run admin -- seu@email.com            -> role "admin"
 *   npm run admin -- seu@email.com --remover  -> role "user"
 *
 * Usa a MONGO_URI do backend/.env. Nenhuma rota da API altera o role.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Usuario = require('../models/Usuario');

async function main() {
  const email = (process.argv[2] || '').toLowerCase().trim();
  const role = process.argv.includes('--remover') ? 'user' : 'admin';

  if (!email || !email.includes('@')) {
    console.error('Uso: npm run admin -- seu@email.com [--remover]');
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI nao definida no backend/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    const resultado = await Usuario.updateOne({ email }, { $set: { role } });
    if (resultado.matchedCount === 0) {
      console.error(`Nenhum usuario com o e-mail ${email}. Cadastre-se no app primeiro.`);
      process.exitCode = 1;
    } else {
      console.log(`${email} agora tem role "${role}". Saia e entre de novo no app.`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((erro) => {
  console.error('Falha:', erro.message);
  process.exit(1);
});
