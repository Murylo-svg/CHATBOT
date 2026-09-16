const { v2: cloudinary } = require('cloudinary');

/**
 * Configuracao.
 * Se CLOUDINARY_URL estiver no .env, o SDK le sozinho.
 * Caso contrario, usa as tres variaveis separadas.
 */
if (!process.env.CLOUDINARY_URL) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  cloudinary.config({ secure: true });
}

/**
 * Envia um buffer de imagem para o Cloudinary.
 * @param {Buffer} buffer
 * @param {string} usuarioId  usado para organizar em pastas
 * @returns {Promise<string>} URL segura da imagem
 */
function enviarImagem(buffer, usuarioId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `agente-ia/${usuarioId}`,
        resource_type: 'image',
        transformation: [{ width: 1024, height: 1024, crop: 'limit', quality: 'auto' }],
      },
      (erro, resultado) => {
        if (erro) return reject(new Error('Cloudinary: ' + erro.message));
        resolve(resultado.secure_url);
      }
    );

    stream.end(buffer);
  });
}

module.exports = { enviarImagem };
