// Prompt compartido: lo usa el navegador (IA gratis) y el Worker (IA Pro).
// La IA solo propone; las canciones se verifican luego con catálogos reales.

// Claves internas de época (las traduce i18n.js).
export const ERA_LABELS = ['Me da igual', 'Lo más nuevo', '2020s', '2010s', '2000s', '90s', 'Clásicos'];
const ERA_EN = { 'Lo más nuevo': 'the newest releases', '2020s': 'the 2020s', '2010s': 'the 2010s', '2000s': 'the 2000s', '90s': 'the 90s', 'Clásicos': 'classics from before 1990' };
const LANG_NAMES = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian' };

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Limpia la entrada del usuario (también en el servidor). */
export function sanitizeInput(raw = {}, maxCount = 30) {
  const list = (v, n, len) => (Array.isArray(v) ? v : []).map((x) => clip(x, len)).filter(Boolean).slice(0, n);
  return {
    prompt: clip(raw.prompt, 600),
    artists: list(raw.artists, 12, 60),
    genres: list(raw.genres, 10, 30),
    moods: list(raw.moods, 10, 30),
    era: ERA_LABELS.includes(raw.era) ? raw.era : ERA_LABELS[0],
    count: Math.max(5, Math.min(maxCount, Number(raw.count) || 25)),
    surprise: Math.max(0, Math.min(100, Number(raw.surprise) || 0)),
    onlyArtists: !!raw.onlyArtists,
    explicit: raw.explicit !== false,
    isPublic: !!raw.isPublic,
    lang: LANG_NAMES[raw.lang] ? raw.lang : 'en',
  };
}

export function buildMessages(input, exclude = []) {
  const ask = Math.min(Math.round(input.count * 1.2) + 4, 110);
  const s = input.surprise;
  const surprise =
    s <= 20 ? 'Pick almost only big, well-known hits.'
    : s <= 45 ? 'Mostly hits, with a few less obvious tracks.'
    : s <= 65 ? 'Balance recognisable hits with less obvious tracks and similar artists.'
    : s <= 85 ? 'Surprise them: at most 30% obvious hits; the rest lesser-known tracks and similar artists they may not know.'
    : 'Surprise them as much as possible: hidden gems, deep cuts, cult or emerging artists that fit. Avoid overplayed hits.';

  const lines = [];
  if (input.prompt) lines.push(`Request (in the user's words): "${input.prompt}"`);
  if (input.artists.length) {
    lines.push(`Artists they definitely want: ${input.artists.join(', ')}.`);
    lines.push(input.onlyArtists ? 'Use ONLY songs by these artists (collaborations are fine).' : 'Include these artists and complete it with similar artists.');
  }
  if (input.genres.length) lines.push(`Genres: ${input.genres.join(', ')}.`);
  if (input.moods.length) lines.push(`Occasion / mood (Spanish labels): ${input.moods.join(', ')}.`);
  if (input.era !== ERA_LABELS[0]) lines.push(`Era: ${ERA_EN[input.era]}.`);
  if (!input.explicit) lines.push('Avoid explicit lyrics.');
  lines.push(surprise);
  if (exclude.length) lines.push(`They already have these, do not repeat them: ${exclude.slice(0, 60).map((e) => clip(e, 80)).join('; ')}.`);
  if (!input.prompt && !input.artists.length && !input.genres.length) lines.push('No hints given: make something varied and surprising from current music.');
  lines.push(`Suggest ${ask} songs.`);

  const system =
    'You are an expert music curator across every genre and country. ' +
    'You interpret what the person asks for and suggest REAL songs; if you are not sure a song exists with that exact title and artist, pick another one you know well. ' +
    'Reply ONLY with valid JSON, no extra text, in exactly this shape:\n' +
    '{"name": "creative playlist name (max 50 characters)", "description": "one catchy sentence (max 150 characters)", ' +
    '"seedArtists": ["3 to 6 artists that best define the requested style"], ' +
    '"genres": ["2 to 4 genres in English, e.g. reggaeton, latin trap, indie pop"], ' +
    '"yearFrom": null or a year, "yearTo": null or a year, ' +
    '"tracks": [{"title": "exact song title without feat.", "artist": "main artist"}]}\n' +
    'Set yearFrom/yearTo only if the request implies an era. Order the songs so the playlist flows. ' +
    `Write "name" and "description" in ${LANG_NAMES[input.lang] || 'English'}. No emojis.`;

  return { system, user: lines.join('\n') };
}

export function parseAI(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  let obj = null;
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { obj = JSON.parse(s.slice(a, b + 1)); } catch {} }
  if (!obj) {
    const i = s.indexOf('['), j = s.lastIndexOf(']');
    if (i !== -1 && j > i) { try { obj = { tracks: JSON.parse(s.slice(i, j + 1)) }; } catch {} }
  }
  if (!obj || !Array.isArray(obj.tracks)) throw new Error('bad-format');
  const tracks = obj.tracks
    .map((t) => ({ title: clip(t?.title || t?.song || t?.name, 120), artist: clip(t?.artist || t?.artists, 120) }))
    .filter((t) => t.title && t.artist);
  if (!tracks.length) throw new Error('bad-format');
  const year = (v) => (Number.isInteger(Number(v)) && Number(v) > 1900 && Number(v) < 2100 ? Number(v) : null);
  return {
    name: clip(obj.name, 100) || 'Vibelist',
    description: clip(obj.description, 280).replace(/^emojis?\s*:?\s*/i, ''),
    seedArtists: (Array.isArray(obj.seedArtists) ? obj.seedArtists : []).map((x) => clip(x, 60)).filter(Boolean).slice(0, 6),
    genres: (Array.isArray(obj.genres) ? obj.genres : []).map((x) => clip(x, 30)).filter(Boolean).slice(0, 5),
    yearFrom: year(obj.yearFrom),
    yearTo: year(obj.yearTo),
    tracks,
  };
}
