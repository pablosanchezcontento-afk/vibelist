// Servidor de suscripciones de Vibelist (Cloudflare Worker, sin dependencias).
//   GET  /config    → ¿está activo Pro?
//   POST /checkout  → crea una sesión de Stripe Checkout (suscripción mensual)
//   GET  /claim     → tras pagar, canjea la sesión por una licencia firmada
//   POST /refresh   → renueva la licencia si la suscripción sigue activa
//   POST /portal    → enlace al portal de Stripe (cambiar tarjeta, cancelar)
//
// Secreto obligatorio (Cloudflare → Worker → Settings → Variables and Secrets):
//   STRIPE_SECRET_KEY  (clave restringida rk_live_… o secreta sk_live_…)
// Variables normales: STRIPE_PRICE_ID, SITE_URL
// La licencia se firma con una clave derivada de STRIPE_SECRET_KEY, así que no
// hace falta ningún otro secreto.

const TOKEN_DAYS = 3; // la licencia caduca pronto y se renueva comprobando Stripe
const ACTIVE = new Set(['active', 'trialing', 'past_due']);
const enc = new TextEncoder();

function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = [env.SITE_URL, 'http://127.0.0.1:5173'].filter(Boolean);
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function signingKey(env) {
  const base = await crypto.subtle.importKey('raw', enc.encode(env.STRIPE_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, enc.encode('vibelist-license-v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issue(env, sub, cus) {
  const body = b64u(enc.encode(JSON.stringify({ sub, cus, exp: Date.now() + TOKEN_DAYS * 86400_000 })));
  const sig = await crypto.subtle.sign('HMAC', await signingKey(env), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}

async function readToken(env, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await signingKey(env), unb64u(sig), enc.encode(body));
    return ok ? JSON.parse(new TextDecoder().decode(unb64u(body))) : null;
  } catch { return null; }
}

async function stripe(env, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe ${res.status}`);
  return data;
}

async function route(req, env, url, h) {
  const ready = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID);
  const site = env.SITE_URL || 'https://vibelist.astraforge.pp.ua';
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (url.pathname === '/config') return json({ pro: ready }, 200, h);
  if (!ready) return json({ error: 'Pro is not configured yet.' }, 503, h);

  if (url.pathname === '/checkout' && req.method === 'POST') {
    const lang = /^[a-z]{2}$/.test(body.lang || '') ? body.lang : 'auto';
    const session = await stripe(env, 'checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      allow_promotion_codes: 'true',
      locale: lang,
      success_url: `${site}/?pro_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/#pricing`,
    });
    return json({ url: session.url }, 200, h);
  }

  if (url.pathname === '/claim') {
    const id = url.searchParams.get('session_id') || '';
    if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) return json({ error: 'Invalid session' }, 400, h);
    const session = await stripe(env, `checkout/sessions/${id}?expand[]=subscription`);
    const sub = session.subscription;
    if (session.status !== 'complete' || !sub || !ACTIVE.has(sub.status)) return json({ error: 'Payment not completed' }, 402, h);
    return json({ token: await issue(env, sub.id, session.customer) }, 200, h);
  }

  if (url.pathname === '/refresh' && req.method === 'POST') {
    const t = await readToken(env, body.token);
    if (!t) return json({ error: 'Invalid licence' }, 401, h);
    const sub = await stripe(env, `subscriptions/${encodeURIComponent(t.sub)}`);
    if (!ACTIVE.has(sub.status)) return json({ error: 'Subscription not active' }, 402, h);
    return json({ token: await issue(env, sub.id, sub.customer) }, 200, h);
  }

  if (url.pathname === '/portal' && req.method === 'POST') {
    const t = await readToken(env, body.token);
    if (!t) return json({ error: 'Invalid licence' }, 401, h);
    const portal = await stripe(env, 'billing_portal/sessions', { customer: t.cus, return_url: site });
    return json({ url: portal.url }, 200, h);
  }

  return json({ error: 'Not found' }, 404, h);
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    try {
      return await route(req, env, new URL(req.url), h);
    } catch (e) {
      return json({ error: e.message || 'Server error' }, 500, h);
    }
  },
};
