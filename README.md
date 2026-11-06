# Vibelist — playlists a la carta con IA

**Web:** https://vibelist.astraforge.pp.ua — traducida a inglés, español, portugués, francés, alemán e italiano (`public/i18n.js`).

La gente escribe lo que quiere escuchar ("reggaeton para una previa con Bad Bunny y Feid, pero sorpréndeme"), afina géneros, plan, época, nº de canciones y sorpresa, y obtiene una playlist de **canciones reales** que puede escuchar (previews de 30 s), guardar en Spotify o exportar a cualquier app.

## Cómo elige las canciones (`public/engine.js`)

1. **IA** interpreta la petición → artistas semilla, géneros, época y canciones propuestas (`public/prompt.js`).
   - Pollinations, gratis y sin clave (1 petición / 45 s por persona), para todos los planes.
2. **ListenBrainz** (datos abiertos de escucha) da artistas similares a las semillas; los que se parecen a varias semillas suben. Cuanta más sorpresa, más se salta a los obvios.
3. **iTunes** da el catálogo real de cada artista (orden ≈ popularidad, año, género, preview).
4. **Puntuación**: origen (IA / pedido / semilla / similar) + popularidad según la sorpresa + género + época + penaliza karaoke, directos y remixes + azar.
5. **Selección**: límite por artista, mínimo garantizado para los artistas pedidos, sin títulos repetidos.
6. **Orden**: curva de enganche (arranca con algo conocido, explora, cierra arriba) sin repetir artista seguido.

No usa datos de Spotify para recomendar: su política prohíbe analizarlos o pasarlos a una IA. Spotify solo se usa para buscar cada canción y crear la playlist.

## Modelo de negocio

| | Gratis | Pro (1,99 €/mes, IVA incluido) |
|---|---|---|
| Playlists | 3 al día | ilimitadas |
| Canciones | hasta 30 | ilimitadas |
| IA | gratuita (Pollinations) | la misma, gratuita |
| Descripción | "Made with Vibelist" | sin marca |
| Cambiar una canción por otra parecida | — | sí |
| Historial de playlists | — | sí |

- El cobro es una **suscripción de Stripe** gestionada por el Cloudflare Worker de `worker/worker.js` (`API_BASE` en `public/config.js`). Secreto `STRIPE_SECRET_KEY`; variables `STRIPE_PRICE_ID` y `SITE_URL`. Stripe gestiona IVA y facturas.
- Al pagar, Stripe redirige a `/?pro_session={CHECKOUT_SESSION_ID}` y la web activa Pro en ese navegador. No hay servidor ni claves secretas.
- Limitación conocida: sin servidor, Pro no se verifica contra Stripe (alguien con conocimientos podría activarlo a mano). Como Pro no cuesta nada mantenerlo, es aceptable para empezar.
- Opcional: enlaces de afiliado de Apple Music (`APPLE_AFFILIATE_TOKEN`).

**Política de Spotify**: cobrar está permitido solo en apps que *no reproducen* música de Spotify; Vibelist no la reproduce (las previews son de Apple).

## Desarrollo local

```bash
npm run dev
```

Abre <http://127.0.0.1:5173/>.

## Publicación

GitHub Pages publica `public/` en cada push a `main` (`.github/workflows/pages.yml`), con el dominio `vibelist.astraforge.pp.ua` (`public/CNAME`). El DNS del dominio está en Cloudflare: `CNAME vibelist → pablosanchezcontento-afk.github.io` (sin proxy).

El enlace de pago es el real (modo live) de la cuenta de Stripe de Pablo.

## El límite de 5 usuarios de Spotify

En modo desarrollo solo 5 cuentas añadidas a mano pueden usar "Guardar en Spotify". El resto usa **Exportar** (copiar lista / CSV → TuneMyMusic), que funciona para cualquiera. Para abrir el guardado directo a todo el mundo hay que pedir *Extended Quota Mode* a Spotify; piden empresa registrada y una base grande de usuarios, así que es para cuando la web crezca.

## Archivos

- `public/` — la web: `index.html`, `styles.css`, `app.js` (interfaz, Pro, exportar), `engine.js` (algoritmo), `prompt.js` (prompt de la IA), `spotify.js` (login y guardado), `i18n.js` (traducciones), `config.js`.
- `serve.mjs` — servidor local.
