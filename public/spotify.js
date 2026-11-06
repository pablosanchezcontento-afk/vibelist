// Spotify: login PKCE (sin secretos) y guardado de la playlist.
// Solo se usa Spotify para buscar cada canción y crear la playlist en la cuenta
// de la persona; no se reproduce nada (app "Non-Streaming" según su política).
import { CONFIG } from './config.js';
import { norm, firstArtist } from './engine.js';
import { t } from './i18n.js';

const SCOPES = 'playlist-modify-private playlist-modify-public';
const K = { token: 'vibelist.token', verifier: 'vibelist.verifier', state: 'vibelist.oauthState' };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const spotifyEnabled = () => Boolean(CONFIG.SPOTIFY_CLIENT_ID);
export const loggedIn = () => Boolean(store.get(K.token)?.access_token);
const redirectUri = () => CONFIG.REDIRECT_URI || location.origin + location.pathname;

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (x) => chars[x % chars.length]).join('');
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login() {
  const verifier = randomString(64);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  store.set(K.verifier, verifier);
  store.set(K.state, state);
  location.href = `https://accounts.spotify.com/authorize?${new URLSearchParams({
    response_type: 'code', client_id: CONFIG.SPOTIFY_CLIENT_ID, scope: SCOPES,
    redirect_uri: redirectUri(), code_challenge_method: 'S256', code_challenge: challenge, state,
  })}`;
}

export function logout() { store.del(K.token); }

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CONFIG.SPOTIFY_CLIENT_ID, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Spotify ${res.status}`);
  const prev = store.get(K.token) || {};
  const tok = { access_token: data.access_token, refresh_token: data.refresh_token || prev.refresh_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
  store.set(K.token, tok);
  return tok;
}

/** Procesa la vuelta del login. Devuelve un mensaje de error o null. */
export async function handleCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return null;
  const clean = new URL(location.href);
  ['code', 'state', 'error'].forEach((k) => clean.searchParams.delete(k));
  history.replaceState(null, '', clean.pathname + clean.search);
  if (p.get('error')) return p.get('error') === 'access_denied' ? t('sp.cancelled') : `Spotify: ${p.get('error')}`;
  if (p.get('state') !== store.get(K.state)) return t('sp.mismatch');
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: redirectUri(), code_verifier: store.get(K.verifier) });
    return null;
  } catch (e) {
    return t('sp.loginFail', { msg: e.message });
  } finally {
    store.del(K.verifier);
    store.del(K.state);
  }
}

async function getToken() {
  const tok = store.get(K.token);
  if (!tok?.access_token) return null;
  if (Date.now() < tok.expires_at - 60_000) return tok.access_token;
  if (!tok.refresh_token) { store.del(K.token); return null; }
  try { return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).access_token; }
  catch { store.del(K.token); return null; }
}

export async function api(path, opts = {}, attempt = 0) {
  const token = await getToken();
  if (!token) throw Object.assign(new Error(t('sp.expired')), { fatal: true });
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 429 && attempt < 4) { await sleep((Number(res.headers.get('Retry-After')) || 2) * 1000); return api(path, opts, attempt + 1); }
  if (res.status === 401 && attempt < 1) {
    const tok = store.get(K.token);
    if (tok) { tok.expires_at = 0; store.set(K.token, tok); }
    return api(path, opts, attempt + 1);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.error?.message || '';
    if (res.status === 403) {
      throw Object.assign(new Error(/scope/i.test(msg) ? t('sp.scope', { msg }) : t('sp.denied')), { fatal: true });
    }
    throw new Error(msg || `Spotify ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export const me = () => api('/me');

function pickMatch(items, title, artist) {
  const t = norm(title), fa = norm(firstArtist(artist)), full = norm(artist);
  return items.find((it) => {
    if (!it) return false;
    const name = norm(it.name);
    const titleOk = name === t || (t.length > 2 && (name.startsWith(t) || t.startsWith(name) || name.includes(t)));
    const artistOk = it.artists.some((x) => { const n = norm(x.name); return n && (n === fa || full.includes(n) || (fa.length > 2 && n.includes(fa))); });
    return titleOk && artistOk;
  });
}

async function findUri(track) {
  const fa = firstArtist(track.artist);
  for (const q of [`track:${track.title} artist:${fa}`, `${track.title} ${fa}`]) {
    const data = await api(`/search?type=track&limit=5&q=${encodeURIComponent(q)}`);
    const hit = pickMatch(data?.tracks?.items || [], track.title, track.artist);
    if (hit) return hit.uri;
  }
  return null;
}

/** Crea la playlist. Devuelve { url, added, missing }. */
export async function savePlaylist({ name, description, isPublic, tracks }, onProgress = () => {}) {
  const uris = new Array(tracks.length).fill(null);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < tracks.length) {
      const i = next++;
      try { uris[i] = await findUri(tracks[i]); } catch (e) { if (e.fatal) throw e; }
      onProgress(++done, tracks.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const found = [...new Set(uris.filter(Boolean))];
  if (!found.length) throw new Error(t('sp.notFound'));
  const pl = await api('/me/playlists', { method: 'POST', body: JSON.stringify({ name, description, public: !!isPublic }) });
  for (let i = 0; i < found.length; i += 100) {
    await api(`/playlists/${pl.id}/items`, { method: 'POST', body: JSON.stringify({ uris: found.slice(i, i + 100) }) });
  }
  return { url: pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}`, added: found.length, missing: tracks.length - found.length };
}
