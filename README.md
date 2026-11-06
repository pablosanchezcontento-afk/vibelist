# Vibelist — playlists a la carta con IA

**Web:** https://vibelist.astraforge.pp.ua — traducida a inglés, español, portugués, francés, alemán e italiano (`public/i18n.js`).

La gente escribe lo que quiere escuchar ("reggaeton para una previa con Bad Bunny y Feid, pero sorpréndeme"), afina géneros, plan, época, nº de canciones y sorpresa, y obtiene una playlist de **canciones reales** que puede escuchar (previews de 30 s), guardar en Spotify o exportar a cualquier app.

## Cómo elige las canciones (`public/engine.js`)

1. **IA** interpreta la petición → artistas semilla, géneros, época y canciones propuestas (`public/prompt.js`).
   - Gratis: Pollinations (sin clave, 1 petición / 45 s por persona).
   - Pro: Claude Haiku 5.5 desde el backend (rápido y mejor).
2. **ListenBrainz** (datos abiertos de escucha) da artistas similares a las semillas; los que se parecen a varias semillas suben. Cuanta más sorpresa, más se salta a los obvios.
3. **iTunes** da el catálogo real de cada artista (orden ≈ popularidad, año, género, preview).
4. **Puntuación**: origen (IA / pedido / semilla / similar) + popularidad según la sorpresa + género + época + penaliza karaoke, directos y remixes + azar.
5. **Selección**: límite por artista, mínimo garantizado para los artistas pedidos, sin títulos repetidos.
6. **Orden**: curva de enganche (arranca con algo conocido, explora, cierra arriba) sin repetir artista seguido.

No usa datos de Spotify para recomendar: su política prohíbe analizarlos o pasarlos a una IA. Spotify solo se usa para buscar cada canción y crear la playlist.

## Modelo de negocio

| | Gratis | Pro (2,99 €/mes, configurable) |
|---|---|---|
| Playlists | 3 al día | Ilimitadas (uso justo) |
| Canciones | hasta 30 | hasta 100 |
| IA | gratuita, con espera de 45 s | Claude, sin esperas |
| Descripción | "Made with Vibelist" (publicidad gratis) | sin marca |

Extra opcional: enlaces de afiliado de Apple Music (`APPLE_AFFILIATE_TOKEN` en `public/config.js`).

**Coste por playlist Pro**: ~0,2 céntimos de IA. Cloudflare Workers es gratis hasta 100.000 peticiones/día. Stripe cobra ~1,5 % + 0,25 € por pago en Europa.

**Política de Spotify**: cobrar está permitido solo en apps que *no reproducen* música de Spotify. Vibelist no la reproduce (las previews son de Apple), así que encaja. Revisa tú los [Developer Terms](https://developer.spotify.com/terms) y la [Developer Policy](https://developer.spotify.com/policy) antes de lanzar.

## Desarrollo local

```bash
npm install
npm run dev
```

Abre <http://127.0.0.1:5173/>. `serve.mjs` sirve `public/` y manda `/api/*` al Worker con las claves de `.dev.vars` (copia `.dev.vars.example`). Sin claves, todo funciona en modo gratis y el botón Pro dice "Muy pronto".

## Ponerlo en marcha y cobrar

1. **Stripe** (<https://dashboard.stripe.com>, cuenta a tu nombre):
   - Crea el producto "Vibelist Pro" con un precio recurrente mensual → copia el `price_…`.
   - Copia la clave secreta `sk_live_…` (o `sk_test_…` para probar).
   - En *Settings → Billing → Customer portal*, actívalo (para "Gestionar suscripción").
2. **Anthropic** (<https://console.anthropic.com>): crea una API key y pon un límite de gasto mensual.
3. **Cloudflare** (gratis):
   ```bash
   npx wrangler login
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_PRICE_ID
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put TOKEN_SECRET
   npm run deploy
   ```
   `TOKEN_SECRET` es cualquier frase larga y aleatoria (firma las licencias Pro).
4. **Spotify**: en el dashboard de la app añade la Redirect URI pública (`https://vibelist.astraforge.pp.ua/`).
5. **Legal**: completa los corchetes de `public/privacy.html` y `public/terms.html`.
6. Opcional: crea el KV `USAGE` (ver `wrangler.toml`) para limitar el uso diario de la IA Pro.

## El límite de 5 usuarios de Spotify

En modo desarrollo solo 5 cuentas añadidas a mano pueden usar "Guardar en Spotify". El resto usa **Exportar** (copiar lista / CSV → TuneMyMusic), que funciona para cualquiera. Para abrir el guardado directo a todo el mundo hay que pedir *Extended Quota Mode* a Spotify; piden empresa registrada y una base grande de usuarios, así que es para cuando la web crezca.

## Archivos

- `public/` — la web: `index.html`, `styles.css`, `app.js` (interfaz, planes, exportar), `engine.js` (algoritmo), `prompt.js` (prompt compartido), `spotify.js` (login y guardado), `config.js`.
- `worker.js` — backend: Stripe Checkout, licencias Pro firmadas, IA Pro.
- `serve.mjs` — servidor local que imita Cloudflare.
- `wrangler.toml` — configuración de despliegue.
