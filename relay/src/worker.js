import { base64url, send } from './providers.js';
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value) { return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
function bearer(request) { return request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1] ?? ''; }
async function equalSecret(a, b) {
  if (!a || !b) return false;
  const x = await digest(a), y = await digest(b);
  let difference = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) difference |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return difference === 0;
}
class Problem extends Error { constructor(status, message) { super(message); this.status = status; } }
async function body(request) {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) throw new Problem(415, 'Use application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new Problem(400, 'Missing body');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); throw new Problem(413, 'Request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new Problem(400, 'Invalid JSON object'); }
}
export function registration(value) {
  if (!['apns', 'fcm'].includes(value.provider)) throw new Problem(400, 'Unknown provider');
  if (!['sandbox', 'production'].includes(value.environment)) throw new Problem(400, 'Unknown environment');
  if (typeof value.token !== 'string' || (value.provider === 'apns'
    ? !/^[a-fA-F0-9]{32,256}$/.test(value.token) || value.token.length % 2 !== 0
    : !/^[A-Za-z0-9:_-]{20,4096}$/.test(value.token))) throw new Problem(400, 'Invalid device token');
  if (value.provider === 'fcm' && value.environment !== 'production') throw new Problem(400, 'FCM uses production');
  return { provider: value.provider, token: value.token, environment: value.environment };
}
export function message(value) {
  if (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 100 ||
      typeof value.body !== 'string' || value.body.length > 1000) throw new Problem(400, 'Invalid title or body');
  const data = value.data ?? {};
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length > 16 ||
      Object.entries(data).some(([key, v]) => typeof v !== 'string' || v.length > 500 ||
        !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || /^(aps|from|message_type|google\.|gcm\.)/.test(key))) {
    throw new Problem(400, 'Invalid message data');
  }
  const result = { title: value.title, body: value.body, data };
  if (encoder.encode(JSON.stringify(result)).length > 3000) throw new Problem(413, 'Message too large');
  return result;
}
// Seconds to hold a test send so the person can leave the app and see how the notification arrives
// while it is in the background. The cap stays inside the time a Worker may keep running after its
// response (`waitUntil`).
export function delay(value) {
  const seconds = value.delay ?? 0;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 20) throw new Problem(400, 'Delay must be 0 to 20 seconds');
  return seconds;
}
export async function handle(request, env, dispatch = send, ctx = undefined) {
  try {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') return json({ service: 'day-push', status: 'ok' });
    if (!env.ADMIN_TOKEN) throw new Problem(503, 'Relay is not configured');
    const authorization = bearer(request);
    const admin = await equalSecret(authorization, env.ADMIN_TOKEN);
    if (request.method === 'POST' && path === '/v1/enrollments') {
      if (!admin) throw new Problem(401, 'Administrator authorization required');
      const code = random(), expires = now() + 600;
      await env.DB.prepare('DELETE FROM enrollments WHERE expires <= ?').bind(now()).run();
      await env.DB.prepare('INSERT INTO enrollments(digest, expires) VALUES (?, ?)').bind(await digest(code), expires).run();
      return json({ code, expires }, 201);
    }
    if (request.method === 'POST' && path === '/v1/devices') {
      const value = await body(request), device = registration(value);
      if (typeof value.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.code)) throw new Problem(401, 'Enrollment code required');
      const enrollment = await env.DB.prepare('DELETE FROM enrollments WHERE digest = ? AND expires > ? RETURNING digest')
        .bind(await digest(value.code), now()).first();
      if (!enrollment) throw new Problem(401, 'Enrollment code expired or already used');
      const id = crypto.randomUUID(), credential = random();
      await env.DB.prepare('INSERT INTO devices(id, credential_digest, provider, token, environment, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, await digest(credential), device.provider, device.token, device.environment, now(), now()).run();
      return json({ id, credential }, 201);
    }
    const match = path.match(/^\/v1\/devices\/([0-9a-f-]{36})(\/test)?$/);
    if (!match || !['POST', 'PUT', 'DELETE'].includes(request.method)) throw new Problem(404, 'Not found');
    const id = match[1];
    const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first();
    if (!device || (!admin && (!authorization || device.credential_digest !== await digest(authorization)))) {
      throw new Problem(401, 'Device authorization required');
    }
    if (request.method === 'DELETE' && !match[2]) {
      await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(id).run();
      return json({ removed: true });
    }
    if (request.method === 'PUT' && !match[2]) {
      const updated = registration(await body(request));
      await env.DB.prepare('UPDATE devices SET provider = ?, token = ?, environment = ?, updated = ? WHERE id = ?')
        .bind(updated.provider, updated.token, updated.environment, now(), id).run();
      return json({ updated: true });
    }
    if (request.method === 'POST' && match[2]) {
      const value = await body(request), payload = message(value), seconds = delay(value);
      const ready = await env.DB.prepare('UPDATE devices SET last_sent = ? WHERE id = ? AND last_sent <= ? RETURNING id')
        .bind(now(), id, now() - 30).first();
      if (!ready) throw new Problem(429, 'Wait 30 seconds between test sends');
      const deliver = async () => {
        const result = await dispatch(env, device, payload);
        if (result.invalidToken) await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(id).run();
        return result;
      };
      if (seconds > 0 && ctx) {
        // The caller learns only that the send is scheduled; a provider rejection after the delay
        // removes an invalid token as usual but has no response left to report it in.
        ctx.waitUntil(new Promise(resolve => setTimeout(resolve, seconds * 1000)).then(deliver).catch(() => {}));
        return json({ scheduled: true, delay: seconds }, 202);
      }
      const result = await deliver();
      return json(result, result.accepted ? 200 : 502);
    }
    throw new Problem(405, 'Method not allowed');
  } catch (error) {
    if (error instanceof Problem) return json({ error: error.message }, error.status);
    // Provider errors can contain credentials or device tokens. Keep them out of public responses.
    return json({ error: 'Relay operation failed' }, 502);
  }
}
export default { fetch(request, env, ctx) { return handle(request, env, send, ctx); } };
