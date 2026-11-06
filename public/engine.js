// Motor de recomendación de Vibelist.
//
// 1. La IA interpreta la petición (artistas semilla, géneros, época y canciones propuestas).
// 2. ListenBrainz (datos abiertos) da artistas similares a las semillas → grafo de artistas.
// 3. iTunes da el catálogo real de cada artista (orden ≈ popularidad, año, género, preview).
// 4. Puntuación: origen (IA / pedido / semilla / similar), popularidad según el nivel de
//    sorpresa, género, época, versiones raras (karaoke, live…) y algo de azar.
// 5. Selección con límites por artista, mínimos para los artistas pedidos y sin duplicados.
// 6. Orden con curva de "enganche": arranca fuerte, explora en el medio y cierra arriba,
//    sin repetir artista seguido.
// No se usa ningún dato de Spotify (su política prohíbe analizarlos o pasarlos a una IA).

const ITUNES = 'https://itunes.apple.com';
const MB = 'https://musicbrainz.org/ws/2';
const LB_SIMILAR = 'https://labs.api.listenbrainz.org/similar-artists/json';
const LB_ALGO = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

const YEAR = new Date().getFullYear();
export const ERA_RANGES = {
  'Lo más nuevo': [YEAR - 1, 2100],
  '2020s': [2020, 2029],
  '2010s': [2010, 2019],
  '2000s': [2000, 2009],
  '90s': [1990, 1999],
  'Clásicos': [1940, 1989],
};

// Nombres de género de iTunes (en varios idiomas) que encajan con cada chip.
const GENRE_MATCH = {
  reggaeton: /urban|urbano|reggaet|latin|latina|latino/i,
  'trap latino': /urban|urbano|latin|latina|latino|hip-?hop|rap/i,
  pop: /pop/i,
  'pop latino': /pop|latin|latina|latino/i,
  rap: /hip-?hop|rap/i,
  'r&b': /r&b|soul/i,
  rock: /rock|metal|punk/i,
  indie: /indie|alternative|alternativ/i,
  'electrónica': /electr|dance|house|techno/i,
  house: /house|dance|electr/i,
  salsa: /salsa|tropical|latin/i,
  bachata: /bachata|tropical|latin/i,
  dembow: /urban|urbano|latin|dembow/i,
  corridos: /mexican|regional|corrido|latin/i,
  flamenco: /flamenco|latin|world|pop/i,
  afrobeats: /afro|african|world/i,
  'k-pop': /k-?pop|pop/i,
  'funk brasileño': /funk|brazil|brasil|mpb/i,
  'lo-fi': /lo-?fi|hip-?hop|electr|chill/i,
  jazz: /jazz/i,
};

const BAD_VERSION = /\b(karaoke|instrumental|acapella|a cappella|sped up|slowed|8d|nightcore|cover|tribute|versi[oó]n karaoke)\b/i;
const LIVE_VERSION = /\b(live|en vivo|en directo|ao vivo|unplugged|session|demo)\b/i;
const REMIX = /\b(remix|rmx|mix|edit|version|versión)\b/i;

/* ───────────── Utilidades ───────────── */
export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s-\s.*$/, ' ')
    .replace(/\b(feat|ft|featuring|con)\b\.?.*$/, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export const firstArtist = (a) => String(a || '').split(/,|&|\s+x\s+|\s+y\s+|\s+and\s+|\bfeat\.?|\bft\.?|\bcon\b/i)[0].trim();
const artistParts = (a) => String(a || '').split(/,|&|\s+x\s+|\s+y\s+|\s+and\s+|\bfeat\.?|\bft\.?|\(|\)/i).map(norm).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function titleMatches(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) > 3 && (x.startsWith(y) || y.startsWith(x)));
}

/* ───────────── iTunes (con caché y límite de ritmo) ───────────── */
// iTunes admite unas ~20 peticiones/minuto por IP: concurrencia baja + caché.
const cache = new Map();
let active = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); } catch (e) { reject(e); } finally {
        active--;
        setTimeout(() => queue.length && queue.shift()(), 150);
      }
    };
    active < 3 ? run() : queue.push(run);
  });
}

async function getJSON(url, { retries = 3 } = {}) {
  if (cache.has(url)) return cache.get(url);
  const p = limited(async () => {
    for (let i = 0; ; i++) {
      const res = await fetch(url);
      if (res.ok) return res.json();
      if (i >= retries || ![403, 429, 503].includes(res.status)) throw new Error(`HTTP ${res.status}`);
      await sleep(4000 * (i + 1));
    }
  });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

const LANG_COUNTRY = { en: 'US', es: 'ES', pt: 'BR', fr: 'FR', de: 'DE', it: 'IT', ja: 'JP', ko: 'KR', nl: 'NL' };
/** Tienda de iTunes según el navegador (es-MX → MX, pt → BR…). */
export function storeCountry() {
  const tag = navigator.languages?.[0] || navigator.language || 'en-US';
  const [l, region] = tag.split('-');
  return region && /^[A-Z]{2}$/i.test(region) ? region.toUpperCase() : (LANG_COUNTRY[l?.toLowerCase()] || 'US');
}

function toTrack(x, extra = {}) {
  return {
    id: x.trackId,
    title: x.trackName,
    artist: x.artistName,
    album: x.collectionName,
    year: Number((x.releaseDate || '').slice(0, 4)) || null,
    genre: x.primaryGenreName || '',
    explicit: x.trackExplicitness === 'explicit',
    art: (x.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
    artSmall: x.artworkUrl100 || '',
    preview: x.previewUrl || null,
    appleUrl: x.trackViewUrl || null,
    ...extra,
  };
}

/** Canciones de un artista, en orden aproximado de popularidad. */
async function artistPool(name, country) {
  const url = `${ITUNES}/search?term=${encodeURIComponent(name)}&entity=song&attribute=artistTerm&limit=50&country=${country}`;
  const data = await getJSON(url).catch(() => null);
  const key = norm(name);
  const items = (data?.results || []).filter((x) => x.kind === 'song' && artistParts(x.artistName).includes(key));
  return items.map((x, i) => toTrack(x, { pop: items.length > 1 ? 1 - i / (items.length - 1) : 1, poolArtist: name }));
}

async function searchSong(title, artist, country) {
  const url = `${ITUNES}/search?term=${encodeURIComponent(`${title} ${firstArtist(artist)}`)}&entity=song&limit=8&country=${country}`;
  const data = await getJSON(url).catch(() => null);
  const fa = norm(firstArtist(artist));
  const hit = (data?.results || []).find((x) => x.kind === 'song' && titleMatches(x.trackName, title) && artistParts(x.artistName).includes(fa));
  return hit ? toTrack(hit, { pop: 0.6, poolArtist: firstArtist(artist) }) : null;
}

/* ───────────── Grafo de artistas (MusicBrainz + ListenBrainz) ───────────── */
let lastMB = 0;
async function mbid(name) {
  const k = `mbid:${norm(name)}`;
  if (cache.has(k)) return cache.get(k);
  const p = (async () => {
    const wait = lastMB + 1100 - Date.now();
    lastMB = Math.max(Date.now(), lastMB + 1100);
    if (wait > 0) await sleep(wait);
    const res = await fetch(`${MB}/artist?query=${encodeURIComponent(`artist:"${name}"`)}&limit=3&fmt=json`);
    if (!res.ok) return null;
    const data = await res.json();
    const best = (data.artists || []).find((a) => norm(a.name) === norm(name)) || data.artists?.[0];
    return best && best.score >= 85 ? best.id : null;
  })().catch(() => null);
  cache.set(k, p);
  return p;
}

/** Artistas similares combinados: los que se parecen a varias semillas suben. */
async function similarArtists(seeds) {
  const ids = (await Promise.all(seeds.map(async (s) => [s, await mbid(s)]))).filter(([, id]) => id);
  const seedKeys = new Set(seeds.map(norm));
  const total = new Map();
  await Promise.all(ids.map(async ([seed, id]) => {
    try {
      const res = await fetch(`${LB_SIMILAR}?artist_mbids=${id}&algorithm=${LB_ALGO}`);
      if (!res.ok) return;
      const list = await res.json();
      const max = Math.max(1, ...list.map((x) => x.score || 0));
      list.slice(0, 40).forEach((x) => {
        const k = norm(x.name);
        if (!k || seedKeys.has(k)) return;
        const cur = total.get(k) || { name: x.name, score: 0, because: seed, best: 0 };
        const sc = (x.score || 0) / max;
        cur.score += sc;
        if (sc > cur.best) { cur.best = sc; cur.because = seed; }
        total.set(k, cur);
      });
    } catch {}
  }));
  return [...total.values()].sort((a, b) => b.score - a.score);
}

/* ───────────── Motor principal ───────────── */
/**
 * @param input  entrada saneada (ver prompt.js)
 * @param brief  respuesta de la IA ya parseada
 * @param opts   { onStatus, exclude: Set de claves ya usadas }
 */
export async function buildPlaylist(input, brief, { onStatus = () => {}, exclude = new Set() } = {}) {
  const country = storeCountry();
  const s = input.surprise / 100;
  const n = input.count;
  const requested = input.artists;
  const reqKeys = new Set(requested.map(norm));

  // Época: la que elige la persona manda; la que deduce la IA solo orienta.
  const hardEra = ERA_RANGES[input.era] || null;
  const softEra = !hardEra && brief.yearFrom ? [brief.yearFrom, brief.yearTo || 2100] : null;

  const genreRes = [...input.genres.map((g) => GENRE_MATCH[g.toLowerCase()]).filter(Boolean),
    ...brief.genres.map((g) => GENRE_MATCH[g.toLowerCase()] || new RegExp(g.split(/\s+/)[0].replace(/[^a-z-]/gi, '') || 'x^', 'i'))];
  const genreOk = (g) => !genreRes.length || genreRes.some((re) => re.test(g));
  const wantsRemix = /remix/i.test(input.prompt);
  const wantsLive = /directo|vivo|live|acústic|acustic|unplugged/i.test(input.prompt);

  // Semillas: pedidas > propuestas por la IA > artistas más repetidos en sus canciones.
  const counts = new Map();
  brief.tracks.forEach((t) => { const a = firstArtist(t.artist); counts.set(a, (counts.get(a) || 0) + 1); });
  const seeds = [];
  const addSeed = (a) => { if (a && !seeds.some((x) => norm(x) === norm(a))) seeds.push(a); };
  requested.forEach(addSeed);
  if (!(input.onlyArtists && requested.length)) {
    brief.seedArtists.forEach(addSeed);
    [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([a]) => addSeed(a));
  }

  // Artistas similares según el nivel de sorpresa.
  onStatus('status.similar');
  let similar = [];
  if (!(input.onlyArtists && requested.length)) {
    const graph = await similarArtists(seeds.slice(0, 3)).catch(() => []);
    const k = clamp(Math.round(n / 3), 4, 40);
    const start = Math.round(s * s * k * 1.2); // más sorpresa → se salta a los más obvios
    similar = graph.slice(start, start + k);
  }

  // Catálogo real de cada artista.
  const poolArtists = [];
  const addPool = (name, role, extra = {}) => {
    if (!name || poolArtists.some((p) => norm(p.name) === norm(name))) return;
    poolArtists.push({ name, role, ...extra });
  };
  requested.forEach((a) => addPool(a, 'requested'));
  const seedLimit = input.onlyArtists && requested.length ? 0 : clamp(Math.round(n / 4), 3, 20);
  seeds.filter((a) => !reqKeys.has(norm(a))).slice(0, seedLimit).forEach((a) => addPool(a, 'seed'));
  similar.forEach((x) => addPool(x.name, 'similar', { sim: x.best, because: x.because }));

  onStatus('status.searching', { done: 0, total: poolArtists.length });
  let done = 0;
  const pools = await Promise.all(poolArtists.map(async (pa) => {
    const tracks = await artistPool(pa.name, country);
    onStatus('status.searching', { done: ++done, total: poolArtists.length });
    return tracks.map((t) => ({ ...t, role: pa.role, sim: pa.sim || 0, because: pa.because || null }));
  }));
  const candidates = new Map(); // id → track
  pools.flat().forEach((t) => { if (!candidates.has(t.id)) candidates.set(t.id, t); });

  // Canciones de la IA: se verifican contra el catálogo; las que no existen se descartan.
  const all = [...candidates.values()];
  const missing = [];
  brief.tracks.forEach((t) => {
    const hit = all.find((c) => titleMatches(c.title, t.title) && artistParts(c.artist).includes(norm(firstArtist(t.artist))));
    if (hit) hit.aiPick = true;
    else missing.push(t);
  });
  const budget = input.onlyArtists ? 0 : Math.min(missing.length, 8);
  if (budget) {
    onStatus('status.verify');
    const found = await Promise.all(missing.slice(0, budget).map((t) => searchSong(t.title, t.artist, country)));
    found.filter(Boolean).forEach((t) => {
      if (!candidates.has(t.id)) candidates.set(t.id, { ...t, role: 'ai', aiPick: true, sim: 0 });
      else candidates.get(t.id).aiPick = true;
    });
  }

  // Puntuación.
  const scored = [];
  for (const t of candidates.values()) {
    if (!input.explicit && t.explicit) continue;
    if (hardEra && t.year && (t.year < hardEra[0] || t.year > hardEra[1])) continue;
    if (BAD_VERSION.test(t.title) || BAD_VERSION.test(t.album || '')) continue;
    const isReq = artistParts(t.artist).some((p) => reqKeys.has(p));
    // Un artista "parecido" de otro género no entra salvo sorpresa máxima.
    if (genreRes.length && t.role === 'similar' && !t.aiPick && !genreOk(t.genre) && input.surprise < 90) continue;
    if (input.onlyArtists && requested.length && !isReq) continue;
    const key = `${norm(t.title)}|${norm(firstArtist(t.artist))}`;
    if (exclude.has(key)) continue;

    let score = 0;
    if (t.aiPick) score += 3;
    if (isReq) score += 1.6;
    else if (t.role === 'seed') score += 1 - 0.3 * s;
    else if (t.role === 'similar') score += 0.3 + 0.8 * t.sim + 0.9 * s; // más sorpresa → más descubrimiento
    const p = t.pop ?? 0.5;
    score += 2.2 * ((1 - s) * p + s * (1 - p) * 0.9);
    if (genreRes.length) score += genreOk(t.genre) ? 0.6 : (t.role === 'similar' ? -1.2 : -0.4);
    if (softEra && t.year) score += t.year >= softEra[0] && t.year <= softEra[1] ? 0.5 : -1.5;
    if (!wantsLive && LIVE_VERSION.test(t.title)) score -= 2.5;
    if (!wantsRemix && REMIX.test(t.title)) score -= 0.8;
    score += Math.random() * 0.7;
    scored.push({ ...t, key, isReq, score, pop: p });
  }
  scored.sort((a, b) => b.score - a.score);

  // Selección con límites.
  const cap = input.onlyArtists && requested.length
    ? Math.ceil(n / requested.length) + 1
    : Math.max(2, Math.round(n / 7));
  const perArtist = new Map();
  const titles = new Set();
  const picked = [];
  const mainOf = (t) => norm(t.poolArtist || firstArtist(t.artist));
  const take = (t) => {
    if (picked.length >= n || picked.includes(t)) return false;
    const m = mainOf(t);
    const tk = norm(t.title);
    if ((perArtist.get(m) || 0) >= cap || titles.has(tk)) return false;
    perArtist.set(m, (perArtist.get(m) || 0) + 1);
    titles.add(tk);
    picked.push(t);
    return true;
  };
  // Mínimo garantizado para cada artista pedido.
  const minReq = requested.length ? Math.min(3, cap, Math.floor(n / requested.length)) : 0;
  requested.forEach((a) => {
    let got = 0;
    for (const t of scored) {
      if (got >= minReq) break;
      if (artistParts(t.artist).includes(norm(a)) && take(t)) got++;
    }
  });
  for (const t of scored) { if (picked.length >= n) break; take(t); }

  // Sobrantes ordenados por puntuación: sirven para "cambiar canción" (Pro).
  const rest = scored.filter((t) => !picked.includes(t)).slice(0, 200)
    .map(({ score, ...t }) => t);
  return {
    tracks: arrange(picked),
    rest,
    stats: {
      aiVerified: picked.filter((t) => t.aiPick).length,
      aiProposed: brief.tracks.length,
      similarUsed: picked.filter((t) => t.role === 'similar' && !t.aiPick).length,
      artists: new Set(picked.map(mainOf)).size,
    },
  };
}

/** Orden con curva de enganche y sin repetir artista seguido. */
function arrange(tracks) {
  const left = [...tracks];
  const out = [];
  const n = tracks.length;
  const want = (i) => {
    const x = n > 1 ? i / (n - 1) : 0;
    if (x < 0.12) return 0.9;
    if (x > 0.9) return 0.85;
    return 0.75 - 0.4 * Math.sin(Math.PI * (x - 0.12) / 0.78);
  };
  for (let i = 0; i < n; i++) {
    const prev = out[i - 1], prev2 = out[i - 2];
    let best = 0, bestCost = Infinity;
    left.forEach((t, j) => {
      const m = norm(t.poolArtist || firstArtist(t.artist));
      let cost = Math.abs(t.pop - want(i)) - (t.aiPick ? 0.05 : 0);
      if (prev && norm(prev.poolArtist || firstArtist(prev.artist)) === m) cost += 1;
      if (prev2 && norm(prev2.poolArtist || firstArtist(prev2.artist)) === m) cost += 0.35;
      if (cost < bestCost) { bestCost = cost; best = j; }
    });
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}
