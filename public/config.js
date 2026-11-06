// Configuración pública de Vibelist (nada de aquí es secreto).
export const CONFIG = {
  // Client ID de la app de Spotify (login PKCE, sin Client Secret).
  SPOTIFY_CLIENT_ID: 'd4ab045e78614daf8dabc42f85e9130c',
  // Vacío = la URL actual. Debe coincidir con una Redirect URI de la app de Spotify.
  REDIRECT_URI: '',

  // IA gratuita y sin clave para el plan gratis (Pollinations, compatible con OpenAI).
  AI_ENDPOINT: 'https://text.pollinations.ai/openai',
  AI_MODEL: 'openai-fast',

  // Límites del plan gratis.
  FREE_MAX_SONGS: 30,
  FREE_PER_DAY: 3,
  PRO_MAX_SONGS: 100,
  PRO_PRICE: '€2.99',

  // URL del backend (Cloudflare Worker). Vacío = mismo dominio que la web.
  API_BASE: '',

  // Opcional: tu token de afiliado de Apple (Apple Services Performance Partners).
  // Se añade a los enlaces de Apple Music para cobrar comisión.
  APPLE_AFFILIATE_TOKEN: '',
};
