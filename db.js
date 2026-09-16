const mongoose = require('mongoose');

async function conectarBanco() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error('MONGO_URI nao definida no .env');
  }

  mongoose.connection.on('connected', () => console.log('MongoDB conectado'));
  mongoose.connection.on('error', (e) => console.error('Erro no MongoDB:', e.message));
  mongoose.connection.on('disconnected', () => console.warn('MongoDB desconectado'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
  });

  return mongoose.connection;
}

module.exports = conectarBanco;
