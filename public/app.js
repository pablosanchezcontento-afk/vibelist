import { CONFIG } from './config.js';
import { ERA_LABELS, buildMessages, parseAI, sanitizeInput } from './prompt.js';
import { buildPlaylist, norm, firstArtist } from './engine.js';
import * as spotify from './spotify.js';
import { LANGS, lang, setLang, t, genreLabel, moodLabel, eraLabel, examples, applyStatic } from './i18n.js';

/* Claves internas (no se muestran: se traducen con genreLabel/moodLabel). */
const GENRES = ['Reggaeton', 'Trap latino', 'Pop', 'Pop latino', 'Rap', 'R&B', 'Rock', 'Indie', 'Electrónica', 'House', 'Salsa', 'Bachata', 'Dembow', 'Corridos', 'Flamenco', 'Afrobeats', 'K-pop', 'Funk brasileño', 'Lo-fi', 'Jazz'];
const MOODS = ['Fiesta', 'Previa', 'Chill', 'Gym', 'Romántico', 'Despecho', 'Carretera', 'Estudiar', 'Dormir', 'Ducha', 'Cena', 'Verano'];

const LS = { pro: 'vibelist.pro', quota: 'vibelist.quota', lastAI: 'vibelist.lastAI', pending: 'vibelist.pending' };
const AI_COOLDOWN_MS = 46_000; // IA gratis: 1 respuesta cada ~45 s por IP

const state = {
  artists: [],
  genres: new Set(),
  moods: new Set(),
  era: ERA_LABELS[0],
  result: null, // { name, description, tracks, stats, input }
  me: null,
  busy: false,
  playingId: null,
};

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const surpriseLabel = (v) => t(`surprise.${v <= 20 ? 0 : v <= 45 ? 1 : v <= 65 ? 2 : v <= 85 ? 3 : 4}`);

let toastTimer;
function toast(msg) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ───────────── Plan Pro (pago único con Stripe Payment Link) ───────────── */
// Pro se guarda en este navegador tras volver de Stripe con ?pro_session=cs_…
// (no hay servidor: la IA es gratuita para todos, Pro solo quita límites).
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,}$/;
const isPro = () => SESSION_RE.test(store.get(LS.pro) || '');
const maxSongs = () => (isPro() ? CONFIG.PRO_MAX_SONGS : CONFIG.FREE_MAX_SONGS);

function buyPro() {
  if (!CONFIG.PRO_PAYMENT_LINK) return;
  const u = new URL(CONFIG.PRO_PAYMENT_LINK);
  u.searchParams.set('locale', lang);
  location.href = u.toString();
}

function unlockPro(code, fromCheckout) {
  if (!SESSION_RE.test(code)) return false;
  store.set(LS.pro, code);
  renderPlan();
  if (fromCheckout) {
    $('licenseOut').textContent = t('license.save');
    $('licenseInput').value = code;
    document.querySelector('.restore').open = true;
    toast(t('toast.proOn'));
  }
  return true;
}

function applyLicense() {
  const ok = unlockPro($('licenseInput').value.trim(), false);
  $('licenseOut').textContent = ok ? t('license.ok') : t('license.bad');
}

/* ───────────── Cupo gratis ───────────── */
const today = () => new Date().toISOString().slice(0, 10);
const quotaUsed = () => { const q = store.get(LS.quota); return q?.day === today() ? q.n : 0; };
const spendQuota = () => store.set(LS.quota, { day: today(), n: quotaUsed() + 1 });

/* ───────────── IA ───────────── */
let loadingTimer;
async function waitCooldown(ms) {
  const until = Date.now() + ms;
  clearInterval(loadingTimer);
  while (Date.now() < until) {
    $('loadingText').textContent = t('status.cooldown', { s: Math.ceil((until - Date.now()) / 1000) });
    await sleep(500);
  }
  rotateLoading();
}

async function freeBrief(input, exclude) {
  const { system, user } = buildMessages(input, exclude);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const last = store.get(LS.lastAI) || 0;
    if (Date.now() - last < AI_COOLDOWN_MS) await waitCooldown(AI_COOLDOWN_MS - (Date.now() - last));
    try {
      store.set(LS.lastAI, Date.now());
      const res = await fetch(CONFIG.AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CONFIG.AI_MODEL,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          reasoning_effort: 'low',
          max_tokens: 6000,
          seed: Math.floor(Math.random() * 1e9),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 402 || res.status === 429) { lastErr = new Error(t('err.aiBusy')); continue; }
      if (!res.ok) throw new Error(data?.error?.message || `AI ${res.status}`);
      return parseAI(data.choices?.[0]?.message?.content);
    } catch (e) { lastErr = e.message === 'bad-format' ? new Error(t('err.aiFormat')) : e; }
  }
  throw lastErr;
}

/* ───────────── Flujo principal ───────────── */
function readInput() {
  return {
    prompt: $('prompt').value,
    artists: [...state.artists],
    genres: [...state.genres],
    moods: [...state.moods],
    era: state.era,
    count: Number($('count').value),
    surprise: Number($('surprise').value),
    onlyArtists: $('onlyArtists').checked,
    explicit: $('explicit').checked,
    isPublic: $('isPublic').checked,
    lang,
  };
}

function applyInput(input) {
  if (!input) return;
  $('prompt').value = input.prompt || '';
  state.artists = input.artists || [];
  state.genres = new Set((input.genres || []).filter((g) => GENRES.includes(g)));
  state.moods = new Set((input.moods || []).filter((m) => MOODS.includes(m)));
  state.era = ERA_LABELS.includes(input.era) ? input.era : ERA_LABELS[0];
  $('count').value = input.count || 25;
  $('surprise').value = input.surprise ?? 50;
  $('onlyArtists').checked = !!input.onlyArtists;
  $('explicit').checked = input.explicit !== false;
  $('isPublic').checked = !!input.isPublic;
  renderControls();
}

function rotateLoading() {
  clearInterval(loadingTimer);
  let i = 1;
  $('loadingText').textContent = t('load.1');
  loadingTimer = setInterval(() => { i = Math.min(i + 1, 4); $('loadingText').textContent = t(`load.${i}`); }, 4000);
}

function setLoading(on, text) {
  state.busy = on;
  $('loading').hidden = !on;
  ['generate', 'save', 'again'].forEach((id) => { $(id).disabled = on; });
  clearInterval(loadingTimer);
  if (!on) return;
  if (text) $('loadingText').textContent = text;
  else rotateLoading();
}

function showError(msg) {
  $('error').textContent = msg || '';
  $('error').hidden = !msg;
}

async function generate({ more = false } = {}) {
  if (state.busy) return;
  showError('');
  const raw = readInput();
  if (raw.count > maxSongs()) {
    showError(t('err.maxSongs', { free: CONFIG.FREE_MAX_SONGS, pro: CONFIG.PRO_MAX_SONGS }));
    $('pricing').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (!isPro() && quotaUsed() >= CONFIG.FREE_PER_DAY) {
    showError(t('err.quota', { n: CONFIG.FREE_PER_DAY }));
    $('pricing').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const input = sanitizeInput(raw, maxSongs());
  const prev = more && state.result ? state.result.tracks : [];
  const exclude = prev.map((x) => `${x.title} - ${x.artist}`);
  const excludeKeys = new Set(prev.map((x) => `${norm(x.title)}|${norm(firstArtist(x.artist))}`));

  $('saved').hidden = true;
  setLoading(true);
  try {
    const brief = await freeBrief(input, exclude);
    const { tracks, stats } = await buildPlaylist(input, brief, {
      exclude: excludeKeys,
      onStatus: (key, vars) => { clearInterval(loadingTimer); $('loadingText').textContent = t(key, vars); },
    });
    if (tracks.length < Math.min(5, input.count)) throw new Error(t('err.notEnough'));
    state.result = {
      name: more && state.result ? $('plName').value : brief.name,
      description: more && state.result ? $('plDesc').value : brief.description,
      tracks, stats, input,
    };
    if (!isPro()) spendQuota();
    renderResult();
    renderQuota();
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError(e.message || t('err.generic'));
  } finally {
    setLoading(false);
  }
}

/* ───────────── Guardar y exportar ───────────── */
function stashPending(autoSave) {
  try {
    sessionStorage.setItem(LS.pending, JSON.stringify({
      input: readInput(),
      result: state.result ? { ...state.result, name: $('plName').value, description: $('plDesc').value } : null,
      autoSave,
    }));
  } catch {}
}
function popPending() {
  try { const v = JSON.parse(sessionStorage.getItem(LS.pending)); sessionStorage.removeItem(LS.pending); return v; } catch { return null; }
}

async function save() {
  if (!state.result || state.busy) return;
  showError('');
  if (!spotify.spotifyEnabled()) return showError(t('err.notConfigured'));
  if (!spotify.loggedIn()) { stashPending(true); return spotify.login(); }
  setLoading(true, t('status.spotify', { done: 0, total: state.result.tracks.length }));
  try {
    const name = ($('plName').value || state.result.name || 'Vibelist').trim().slice(0, 100);
    let description = ($('plDesc').value || '').replace(/\s+/g, ' ').trim();
    if (!isPro()) description = `${description ? `${description} · ` : ''}${t('sp.madeWith')}`;
    const out = await spotify.savePlaylist(
      { name, description: description.slice(0, 280), isPublic: state.result.input.isPublic, tracks: state.result.tracks },
      (done, total) => { $('loadingText').textContent = t('status.spotify', { done, total }); },
    );
    $('openLink').href = out.url;
    $('savedInfo').textContent = t('saved.info', { added: out.added }) + (out.missing ? ` ${t('saved.missing', { missing: out.missing })}` : '');
    $('saved').hidden = false;
    $('saved').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError(e.message || t('err.saveFail'));
  } finally {
    setLoading(false);
  }
}

function shareUrl() {
  const i = readInput();
  const u = new URL(location.origin + location.pathname);
  if (i.prompt.trim()) u.searchParams.set('q', i.prompt.trim());
  if (i.artists.length) u.searchParams.set('a', i.artists.join(','));
  if (i.genres.length) u.searchParams.set('g', i.genres.join(','));
  if (i.moods.length) u.searchParams.set('m', i.moods.join(','));
  if (i.era !== ERA_LABELS[0]) u.searchParams.set('e', i.era);
  u.searchParams.set('n', i.count);
  u.searchParams.set('s', i.surprise);
  if (i.onlyArtists) u.searchParams.set('o', '1');
  return u.toString();
}

function readShareParams() {
  const p = new URLSearchParams(location.search);
  if (!p.has('q') && !p.has('a') && !p.has('g')) return;
  const list = (k) => (p.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
  applyInput({
    prompt: p.get('q') || '', artists: list('a'), genres: list('g'), moods: list('m'),
    era: p.get('e') || ERA_LABELS[0], count: Math.min(Number(p.get('n')) || 25, maxSongs()), surprise: Number(p.get('s') ?? 50), onlyArtists: p.get('o') === '1',
  });
}

async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { window.prompt(t('toast.copyHere'), text); }
}

function exportAs(kind) {
  const r = state.result;
  $('exportMenu').hidden = true;
  $('exportBtn').setAttribute('aria-expanded', 'false');
  if (kind === 'share') return copyText(shareUrl(), t('toast.shared'));
  if (!r) return;
  if (kind === 'copy') return copyText(r.tracks.map((x) => `${x.artist} - ${x.title}`).join('\n'), t('toast.copied'));
  if (kind === 'csv') {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['Title,Artist,Album', ...r.tracks.map((x) => [x.title, x.artist, x.album].map(q).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${(($('plName').value || 'playlist').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'playlist')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}

/* ───────────── Previews ───────────── */
function togglePreview(track) {
  const player = $('player');
  if (state.playingId === track.id && !player.paused) { player.pause(); return; }
  player.src = track.preview;
  player.play().catch(() => toast(t('toast.previewFail')));
  state.playingId = track.id;
  markPlaying();
}
function markPlaying() {
  const player = $('player');
  document.querySelectorAll('.track').forEach((li) => {
    const on = li.dataset.id === String(state.playingId) && !player.paused;
    li.classList.toggle('playing', on);
    const b = li.querySelector('.play');
    if (b) { b.textContent = on ? '❚❚' : '▶'; b.setAttribute('aria-label', t(on ? 'track.pause' : 'track.play')); }
  });
}

/* ───────────── Render ───────────── */
function chip(label, pressed, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

function renderControls() {
  const g = $('genres'); g.replaceChildren();
  GENRES.forEach((x) => g.append(chip(genreLabel(x), state.genres.has(x), () => { state.genres.has(x) ? state.genres.delete(x) : state.genres.add(x); renderControls(); })));
  const m = $('moods'); m.replaceChildren();
  MOODS.forEach((x) => m.append(chip(moodLabel(x), state.moods.has(x), () => { state.moods.has(x) ? state.moods.delete(x) : state.moods.add(x); renderControls(); })));
  const e = $('eras'); e.replaceChildren();
  ERA_LABELS.forEach((x) => e.append(chip(eraLabel(x), state.era === x, () => { state.era = x; renderControls(); })));
  renderTags();
  renderCount();
  $('surpriseOut').textContent = surpriseLabel(Number($('surprise').value));
}

function renderCount() {
  const v = Number($('count').value);
  $('countOut').textContent = v;
  $('countLock').hidden = isPro() || v <= CONFIG.FREE_MAX_SONGS;
}

function renderTags() {
  const box = $('artistTags');
  box.querySelectorAll('.tag').forEach((n) => n.remove());
  state.artists.forEach((a, i) => {
    const el = document.createElement('span');
    el.className = 'tag';
    el.innerHTML = `${esc(a)}<button type="button" aria-label="${esc(t('tag.remove', { a }))}">×</button>`;
    el.querySelector('button').addEventListener('click', () => { state.artists.splice(i, 1); renderTags(); });
    box.insertBefore(el, $('artistInput'));
  });
}

function addArtist(raw) {
  raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((a) => {
    if (!state.artists.some((x) => x.toLowerCase() === a.toLowerCase()) && state.artists.length < 12) state.artists.push(a);
  });
  renderTags();
}

function renderExamples() {
  const box = $('examples');
  box.replaceChildren();
  examples().forEach((txt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = txt;
    b.addEventListener('click', () => { $('prompt').value = txt; $('prompt').focus(); });
    box.append(b);
  });
}

function renderAccount() {
  const box = $('account');
  box.replaceChildren();
  if (!spotify.spotifyEnabled()) return;
  if (spotify.loggedIn()) {
    const span = document.createElement('span');
    span.className = 'hello';
    span.textContent = state.me ? t('sp.hello', { name: state.me.display_name || state.me.id }) : t('sp.connected');
    const out = document.createElement('button');
    out.className = 'btn ghost small';
    out.textContent = t('sp.logout');
    out.addEventListener('click', () => { spotify.logout(); state.me = null; renderAccount(); });
    box.append(span, out);
  } else {
    const b = document.createElement('button');
    b.className = 'btn ghost small';
    b.textContent = t('sp.connect');
    b.addEventListener('click', () => { stashPending(false); spotify.login(); });
    box.append(b);
  }
}

function renderPlanLists() {
  const fill = (id, items) => { $(id).innerHTML = items.map((s) => `<li>${esc(s)}</li>`).join(''); };
  fill('freeList', [t('plan.f1', { n: CONFIG.FREE_PER_DAY }), t('plan.f2', { n: CONFIG.FREE_MAX_SONGS }), t('plan.f3'), t('plan.f4')]);
  fill('proList', [t('plan.p1'), t('plan.p2', { n: CONFIG.PRO_MAX_SONGS }), t('plan.p3'), t('plan.p4')]);
}

function renderPlan() {
  const pro = isPro();
  $('planBadge').hidden = !pro;
  const on = Boolean(CONFIG.PRO_PAYMENT_LINK);
  $('buyPro').hidden = pro;
  $('buyPro').disabled = !on;
  $('buyPro').textContent = t(on ? 'btn.buy' : 'btn.soon');
  $('proPrice').innerHTML = `${esc(CONFIG.PRO_PRICE)}<small>${esc(t('plan.once'))}</small>`;
  renderCount();
  renderQuota();
}

function renderQuota() {
  $('quota').textContent = isPro()
    ? t('quota.pro')
    : t('quota.left', { left: Math.max(0, CONFIG.FREE_PER_DAY - quotaUsed()), total: CONFIG.FREE_PER_DAY });
}

function appleLink(url) {
  if (!url) return null;
  const u = new URL(url);
  if (CONFIG.APPLE_AFFILIATE_TOKEN) u.searchParams.set('at', CONFIG.APPLE_AFFILIATE_TOKEN);
  return u.toString();
}

function renderResult() {
  const r = state.result;
  if (!r) return;
  $('result').hidden = false;
  $('plName').value = r.name;
  $('plDesc').value = r.description;

  const st = r.stats || {};
  const parts = [t('stats.songs', { n: r.tracks.length }), t('stats.artists', { n: st.artists || '?' })];
  if (st.similarUsed) parts.push(t('stats.similar', { n: st.similarUsed }));
  parts.push(t('stats.real'));
  $('stats').textContent = parts.join(' · ');

  const imgs = [...new Set(r.tracks.map((x) => x.art).filter(Boolean))].slice(0, 4);
  const cover = $('cover');
  cover.className = imgs.length >= 4 ? 'cover' : 'cover solo';
  cover.innerHTML = (imgs.length >= 4 ? imgs : imgs.slice(0, 1)).map((u) => `<img src="${esc(u)}" alt="">`).join('');

  const list = $('tracks');
  list.replaceChildren();
  r.tracks.forEach((x, i) => {
    const li = document.createElement('li');
    li.className = 'track';
    li.dataset.id = x.id;
    const why = x.role === 'similar' && x.because && !x.aiPick ? `<span class="why">${esc(t('why.similar', { artist: x.because }))}</span>` : '';
    const sp = `https://open.spotify.com/search/${encodeURIComponent(`${x.title} ${firstArtist(x.artist)}`)}`;
    const am = appleLink(x.appleUrl);
    li.innerHTML =
      `<div class="art-wrap">${x.artSmall ? `<img class="art" src="${esc(x.artSmall)}" alt="" loading="lazy">` : '<span class="art ph">♪</span>'}` +
      `${x.preview ? `<button class="play" type="button" aria-label="${esc(t('track.play'))}">▶</button>` : ''}</div>` +
      `<div class="tinfo"><span class="tname">${esc(x.title)}</span>` +
      `<div class="tartist">${x.explicit ? '<span class="badge">E</span>' : ''}${esc(x.artist)}${x.year ? ` · ${x.year}` : ''}</div>${why}</div>` +
      `<div class="tlinks">` +
      `<a href="${esc(sp)}" target="_blank" rel="noopener" title="${esc(t('track.spotify'))}" aria-label="${esc(t('track.spotify'))}">S</a>` +
      (am ? `<a href="${esc(am)}" target="_blank" rel="noopener" title="${esc(t('track.apple'))}" aria-label="${esc(t('track.apple'))}">♫</a>` : '') +
      `<button class="remove" type="button" aria-label="${esc(t('track.remove'))}">×</button></div>`;
    li.querySelector('.play')?.addEventListener('click', () => togglePreview(x));
    li.querySelector('.remove').addEventListener('click', () => { r.tracks.splice(i, 1); renderResult(); });
    list.append(li);
  });
  markPlaying();
  $('saveHint').textContent = spotify.loggedIn() ? '' : t('hint.login');
}

/** Pinta todos los textos en el idioma actual. */
function renderLanguage() {
  applyStatic();
  renderExamples();
  renderControls();
  renderPlanLists();
  renderPlan();
  renderAccount();
  if (state.result) renderResult();
}

/* ───────────── Arranque ───────────── */
function bind() {
  const sel = $('langSelect');
  Object.entries(LANGS).forEach(([code, name]) => sel.append(new Option(name, code, false, code === lang)));
  sel.addEventListener('change', () => { setLang(sel.value); renderLanguage(); });

  $('form').addEventListener('submit', (e) => { e.preventDefault(); generate(); });
  $('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });
  $('artistInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addArtist(e.target.value); e.target.value = ''; }
    else if (e.key === 'Backspace' && !e.target.value && state.artists.length) { state.artists.pop(); renderTags(); }
  });
  $('artistInput').addEventListener('blur', (e) => { if (e.target.value.trim()) { addArtist(e.target.value); e.target.value = ''; } });
  $('artistTags').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('artistInput').focus(); });
  $('count').addEventListener('input', renderCount);
  $('surprise').addEventListener('input', () => { $('surpriseOut').textContent = surpriseLabel(Number($('surprise').value)); });
  $('save').addEventListener('click', save);
  $('again').addEventListener('click', () => generate({ more: true }));
  $('exportBtn').addEventListener('click', () => {
    const open = $('exportMenu').hidden;
    $('exportMenu').hidden = !open;
    $('exportBtn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) { $('exportMenu').hidden = true; $('exportBtn').setAttribute('aria-expanded', 'false'); } });
  $('exportMenu').addEventListener('click', (e) => { const k = e.target.closest('[data-export]')?.dataset.export; if (k) exportAs(k); });
  $('buyPro').addEventListener('click', buyPro);
  $('licenseApply').addEventListener('click', applyLicense);
  ['play', 'pause', 'ended'].forEach((ev) => $('player').addEventListener(ev, markPlaying));
}

async function init() {
  bind();
  renderLanguage();
  readShareParams();

  const params = new URLSearchParams(location.search);
  const proSession = params.get('pro_session');
  if (params.has('pro_session') || params.has('pro')) {
    const u = new URL(location.href);
    u.searchParams.delete('pro_session');
    u.searchParams.delete('pro');
    history.replaceState(null, '', u.pathname + u.search);
  }
  if (proSession) unlockPro(proSession, true);

  if (spotify.spotifyEnabled()) {
    const err = await spotify.handleCallback();
    if (err) showError(err);
    const pending = popPending();
    if (pending) {
      applyInput(pending.input);
      if (pending.result) { state.result = pending.result; renderResult(); }
    }
    if (spotify.loggedIn()) spotify.me().then((me) => { state.me = me; renderAccount(); }).catch(() => {});
    renderAccount();
    if (pending?.autoSave && spotify.loggedIn() && state.result) save();
  }
}

init();
