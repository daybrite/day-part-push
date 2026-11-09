import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

async function privateKey(algorithm) {
  const parameters = algorithm === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const keys = await crypto.subtle.generateKey(parameters, true, ['sign', 'verify']);
  const bytes = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(bytes).toString('base64')}\n-----END PRIVATE KEY-----`;
}

test('Worker runtime signs and sends APNs and FCM requests without following redirects', async () => {
  const calls = [];
  let redirect = false;
  const admin = 'a'.repeat(43);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['worker.js', 'policy.js', 'providers.js'].map(name => ({
      type: 'ESModule', path: fileURLToPath(new URL(`../src/${name}`, import.meta.url)),
    })),
    compatibilityDate: '2026-11-01',
    d1Databases: ['DB'],
    bindings: {
      ADMIN_TOKEN: admin, APNS_PRIVATE_KEY: await privateKey('ES256'),
      APNS_KEY_ID: 'fixture', APNS_TEAM_ID: 'fixture', APNS_TOPIC: 'dev.example.fixture',
      FCM_PROJECT_ID: 'fixture',
      FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'fixture', client_email: 'fixture@example.test', private_key: await privateKey('RS256') }),
    },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push(url.hostname);
      if (url.hostname === 'oauth2.googleapis.com') {
        assert.match(await request.text(), /assertion=/);
        return Response.json({ access_token: 'fixture-access-token', expires_in: 3600 });
      }
      assert.ok(['api.sandbox.push.apple.com', 'fcm.googleapis.com'].includes(url.hostname));
      assert.match(request.headers.get('authorization'), /bearer /i);
      const payload = await request.json();
      if (url.hostname === 'fcm.googleapis.com') assert.equal(payload.message.android.restricted_package_name, 'dev.example.fixture');
      else assert.equal(payload.aps.alert.title, 'Hello from Day');
      if (redirect) return new Response(null, { status: 307, headers: { location: 'https://unexpected.example.test/' } });
      return Response.json({});
    },
  }));
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replaceAll('\n', ' '));
    const dispatch = (path, value, token = admin) => mf.dispatchFetch('https://relay.test' + path, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    for (const provider of ['apns', 'fcm']) {
      for (const shouldRedirect of [false, true]) {
        redirect = shouldRedirect;
        const registration = await (await dispatch('/v1/devices', {
          provider, token: 'a'.repeat(64), environment: provider === 'apns' ? 'sandbox' : 'production',
        }, '')).json();
        const result = await dispatch(`/v1/devices/${registration.id}/test`, { locale: 'en' }, registration.credential);
        assert.equal(result.status, shouldRedirect ? 502 : 200);
        assert.equal((await result.json()).accepted, !shouldRedirect);
      }
    }
    assert.deepEqual(calls, ['api.sandbox.push.apple.com', 'api.sandbox.push.apple.com', 'oauth2.googleapis.com', 'fcm.googleapis.com', 'fcm.googleapis.com']);
    // The cron trigger's cleanup runs against D1 in the Workers runtime; recent registrations stay.
    const before = await db.prepare('SELECT COUNT(*) AS count FROM devices').first();
    assert.equal((await (await mf.getWorker()).scheduled({ cron: '23 * * * *' })).outcome, 'ok');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM devices').first()).count, before.count);
  } finally { await mf.dispose(); }
});
