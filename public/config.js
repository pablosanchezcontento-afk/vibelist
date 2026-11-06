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
  PRO_MAX_SONGS: 500, // en la práctica, sin límite
  PRO_PRICE: '€4.99',
  // Enlace de pago de Stripe (pago único). Al pagar, Stripe vuelve a
  // https://vibelist.astraforge.pp.ua/?pro_session={CHECKOUT_SESSION_ID}
  PRO_PAYMENT_LINK: 'https://buy.stripe.com/7sY5kF2QX96I4Q3ckHcs800',

  // Opcional: tu token de afiliado de Apple (Apple Services Performance Partners).
  // Se añade a los enlaces de Apple Music para cobrar comisión.
  APPLE_AFFILIATE_TOKEN: '',
};
