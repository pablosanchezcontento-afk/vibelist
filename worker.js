// Backend de Vibelist (Cloudflare Worker). Sirve la web (carpeta public/) y la API:
//   GET  /api/config    → ¿está activo el plan Pro? precio
//   POST /api/checkout  → crea una sesión de Stripe Checkout (suscripción)
//   GET  /api/claim     → tras pagar, canjea la sesión por una licencia Pro firmada
//   POST /api/refresh   → renueva la licencia si la suscripción sigue activa
//   POST /api/portal    → enlace al portal de Stripe (cambiar tarjeta, cancelar)
//   POST /api/ai        → IA Pro (Claude) — solo con licencia válida
//
// Secretos (wrangler secret put …  /  .dev.vars en local):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_ID, TOKEN_SECRET, ANTHROPIC_API_KEY
// Variables opcionales: PRO_PRICE_LABEL, CLAUDE_MODEL, PUBLIC_URL, PRO_DAILY_LIMIT
// KV opcional "USAGE" para limitar el uso diario de la IA Pro por suscripción.
import Anthropic from '@anthropic-ai/sdk';
import { buildMessages, parseAI, sanitizeInput } from './public/prompt.js';

const TOKEN_DAYS = 3; // la licencia caduca pronto y se renueva comprobando Stripe

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const proEnabled = (env) => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID && env.TOKEN_SECRET && env.ANTHROPIC_API_KEY);

/* ───────────── Licencia firmada (HMAC-SHA256) ───────────── */
const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signToken(env, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}

/** Devuelve el payload si la firma es válida (aunque haya caducado), o null. */
async function readToken(env, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.TOKEN_SECRET), unb64u(sig), enc.encode(body));
    return ok ? JSON.parse(new TextDecoder().decode(unb64u(body))) : null;
  } catch { return null; }
}

const issue = (env, sub, cus) => signToken(env, { sub, cus, exp: Date.now() + TOKEN_DAYS * 86400_000 });

/* ───────────── Stripe (API REST, sin SDK) ───────────── */
async function stripe(env, path, params, method = params ? 'POST' : 'GET') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe ${res.status}`);
  return data;
}

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

/* ───────────── Rutas ───────────── */
async function route(req, env, url) {
  const origin = env.PUBLIC_URL || url.origin;
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (url.pathname === '/api/config') {
    return json({ pro: proEnabled(env), price: env.PRO_PRICE_LABEL || '€2.99' });
  }

  if (!proEnabled(env)) return json({ error: 'El plan Pro todavía no está activado.' }, 503);

  if (url.pathname === '/api/checkout' && req.method === 'POST') {
    const session = await stripe(env, 'checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      allow_promotion_codes: 'true',
      success_url: `${origin}/?pro_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?pro=cancel`,
    });
    return json({ url: session.url });
  }

  if (url.pathname === '/api/claim') {
    const id = url.searchParams.get('session_id') || '';
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ error: 'Sesión no válida' }, 400);
    const session = await stripe(env, `checkout/sessions/${id}?expand[]=subscription`);
    const sub = session.subscription;
    if (session.status !== 'complete' || !sub || !ACTIVE.has(sub.status)) return json({ error: 'El pago no está completado.' }, 402);
    return json({ token: await issue(env, sub.id, session.customer) });
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    const t = await readToken(env, body.token);
    if (!t) return json({ error: 'Licencia no válida' }, 401);
    const sub = await stripe(env, `subscriptions/${encodeURIComponent(t.sub)}`);
    if (!ACTIVE.has(sub.status)) return json({ error: 'Tu suscripción Pro no está activa.' }, 402);
    return json({ token: await issue(env, sub.id, sub.customer) });
  }

  if (url.pathname === '/api/portal' && req.method === 'POST') {
    const t = await readToken(env, body.token);
    if (!t) return json({ error: 'Licencia no válida' }, 401);
    const portal = await stripe(env, 'billing_portal/sessions', { customer: t.cus, return_url: origin });
    return json({ url: portal.url });
  }

  if (url.pathname === '/api/ai' && req.method === 'POST') {
    const t = await readToken(env, body.token);
    if (!t) return json({ error: 'Licencia no válida' }, 401);
    if (t.exp < Date.now()) return json({ error: 'expired' }, 401);

    if (env.USAGE) {
      const key = `ai:${t.sub}:${new Date().toISOString().slice(0, 10)}`;
      const used = Number(await env.USAGE.get(key)) || 0;
      if (used >= (Number(env.PRO_DAILY_LIMIT) || 150)) return json({ error: 'Has llegado al límite diario de uso justo. Vuelve mañana.' }, 429);
      await env.USAGE.put(key, String(used + 1), { expirationTtl: 172800 });
    }

    // El prompt se construye aquí (no se acepta texto libre como prompt de sistema).
    const input = sanitizeInput(body.input, 100);
    const exclude = (Array.isArray(body.exclude) ? body.exclude : []).slice(0, 60).map(String);
    const { system, user } = buildMessages(input, exclude);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const msg = await client.messages.create({
        model: env.CLAUDE_MODEL || 'claude-haiku-5-5',
        max_tokens: 16000,
        output_config: { effort: 'low' },
        system,
        messages: [{ role: 'user', content: user }],
      });
      if (msg.stop_reason === 'refusal') return json({ error: 'La IA no ha podido hacer esta playlist. Prueba a reformularla.' }, 422);
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return json({ brief: parseAI(text) });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return json({ error: 'La IA está saturada. Prueba en unos segundos.' }, 429);
      if (e instanceof Anthropic.APIError) return json({ error: `Error de la IA (${e.status}).` }, 502);
      throw e;
    }
  }

  return json({ error: 'No encontrado' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('No encontrado', { status: 404 });
    }
    try {
      return await route(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || 'Error interno' }, 500);
    }
  },
};
