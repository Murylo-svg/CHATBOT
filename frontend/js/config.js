/* ============================================================
   ÚNICO ARQUIVO QUE VOCÊ PRECISA EDITAR AO PUBLICAR.
   Troque pela URL do seu backend no Render (sem barra no final).
   ============================================================ */

const API_URL_PRODUCAO = "https://agente-ia-backend-y32a.onrender.com";

// Rodando o front em localhost? Usa o backend local (npm run dev na porta 3000).
const API_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? "http://localhost:3000"
  : API_URL_PRODUCAO;

// O Socket.io usa o mesmo servidor HTTP do Express, então o endereço é o mesmo.
const SOCKET_URL = API_URL;

// Exemplo em produção:
// const API_URL_PRODUCAO = "https://agente-ia-backend.onrender.com";
