import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handle, registration, message, delay, prune } from '../src/worker.js';
import { sample, network, REGISTRATION_SECONDS, REGISTRATIONS_PER_NETWORK_HOUR, MAX_REGISTRATIONS } from '../src/policy.js';
import { signJwt, apnsPayload, send } from '../src/providers.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...args) { return {
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { return db.prepare(sql).run(...args); },
  }; } }; } };
}
const admin = 'a'.repeat(43);
const env = () => ({ DB: database(), ADMIN_TOKEN: admin });
function request(path, method, token, value, ip = '203.0.113.7') {
  return new Request('https://push.example.test' + path, { method,
    headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}
const apns = { provider: 'apns', token: 'a'.repeat(64), environment: 'sandbox' };
async function enroll(environment, ip) {
  const response = await handle(request('/v1/devices', 'POST', null, apns, ip), environment);
  assert.equal(response.status, 201);
  return response.json();
}
const sends = () => {
  const payloads = [];
  return { payloads, dispatch: async (_env, _device, payload) => { payloads.push(payload); return { accepted: true, provider: 'apns', status: 200 }; } };
};
test('any device can register without an administrator, and gets its own credential', async () => {
  const e = env(), a = await enroll(e), b = await enroll(e);
  assert.notEqual(a.id, b.id);
  assert.match(a.credential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await handle(request('/v1/enrollments', 'POST', admin), e)).status, 404);
});
test('registrations are limited per network and hour, with IPv6 counted by /64', async () => {
  const e = env();
  for (let i = 0; i < REGISTRATIONS_PER_NETWORK_HOUR; i++) await enroll(e, '198.51.100.1');
  assert.equal((await handle(request('/v1/devices', 'POST', null, apns, '198.51.100.1'), e)).status, 429);
  await enroll(e, '198.51.100.2');
  for (let i = 0; i < REGISTRATIONS_PER_NETWORK_HOUR; i++) await enroll(e, `2001:db8:0:1::${i + 1}`);
  assert.equal((await handle(request('/v1/devices', 'POST', null, apns, '2001:db8::1:ffff:0:0:1'), e)).status, 429);
  await enroll(e, '2001:db8:0:2::1');
  // A new hour starts a new count.
  await e.DB.prepare('UPDATE enrollment_limits SET period = period - 1').bind().run();
  await enroll(e, '198.51.100.1');
  assert.equal(network(request('/', 'GET', null, undefined, '2001:DB8:0:1:0:0:0:9')), '2001:db8:0:1::/64');
  assert.equal(network(request('/', 'GET', null, undefined, '::1')), '0:0:0:0::/64');
});
test('the relay refuses new registrations once it holds the maximum', async () => {
  const e = env(), insert = e.DB.prepare(`INSERT INTO devices(id, credential_digest, provider, token, environment, created, updated)
    VALUES (?, 'x', 'apns', 'a', 'sandbox', ?, ?)`), time = Math.floor(Date.now() / 1000);
  for (let i = 0; i < MAX_REGISTRATIONS; i++) await insert.bind(`fixture-${i}`, time, time).run();
  assert.equal((await handle(request('/v1/devices', 'POST', null, apns), e)).status, 503);
  // Expired rows no longer count.
  await e.DB.prepare('UPDATE devices SET updated = ?').bind(time - REGISTRATION_SECONDS).run();
  await enroll(e);
});
test('a device can send only to its registration, only the relay sample, and sends are rate limited', async () => {
  const e = env(), a = await enroll(e), b = await enroll(e), { payloads, dispatch } = sends();
  assert.equal((await handle(request(`/v1/devices/${a.id}/test`, 'POST', b.credential, {}), e, dispatch)).status, 401);
  for (const override of [{ title: 'Your account is locked' }, { body: 'Sign in again' }, { data: { link: 'x' } }]) {
    assert.equal((await handle(request(`/v1/devices/${a.id}/test`, 'POST', a.credential, override), e, dispatch)).status, 400);
  }
  assert.equal((await handle(request(`/v1/devices/${a.id}/test`, 'POST', a.credential, { locale: 'fr-CA' }), e, dispatch)).status, 200);
  assert.equal((await handle(request(`/v1/devices/${a.id}/test`, 'POST', a.credential, {}), e, dispatch)).status, 429);
  assert.deepEqual(payloads, [sample('fr')]);
  assert.equal(payloads[0].title, 'Bonjour de la part de Day');
  // The administrator still chooses the text.
  const custom = { title: 'Maintenance', body: 'The relay restarts at noon.' };
  assert.equal((await handle(request(`/v1/devices/${b.id}/test`, 'POST', admin, custom), e, dispatch)).status, 200);
  assert.equal(payloads[1].title, 'Maintenance');
});
test('the sample follows the closest catalog language and rejects malformed locales', () => {
  assert.equal(sample().title, 'Hello from Day');
  assert.equal(sample('zh_Hans').title, sample('zh-CN').title);
  assert.equal(sample('ar-EG').title, 'مرحبًا من Day');
  assert.equal(sample('de-DE').title, 'Hello from Day');
  assert.throws(() => sample('../en'));
  assert.throws(() => sample(5));
});
test('registrations unused for a week expire, and pruning deletes them', async () => {
  const e = env(), a = await enroll(e), b = await enroll(e), old = Math.floor(Date.now() / 1000) - REGISTRATION_SECONDS;
  await e.DB.prepare('UPDATE devices SET updated = ?, last_sent = ? WHERE id = ?').bind(old, old, a.id).run();
  assert.equal((await handle(request(`/v1/devices/${a.id}/test`, 'POST', a.credential, {}), e, sends().dispatch)).status, 404);
  assert.equal((await handle(request(`/v1/devices/${a.id}`, 'PUT', a.credential, apns), e)).status, 404);
  // A recent send keeps an old registration alive.
  await e.DB.prepare('UPDATE devices SET updated = ?, last_sent = ? WHERE id = ?').bind(old, old + 3600, b.id).run();
  await e.DB.prepare('UPDATE enrollment_limits SET period = period - 1').bind().run();
  await prune(e);
  assert.equal(await e.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(a.id).first(), null);
  assert.notEqual(await e.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(b.id).first(), null);
  assert.equal(await e.DB.prepare('SELECT * FROM enrollment_limits').bind().first(), null);
});
test('a delayed test send answers at once and reaches the provider after the delay',async()=>{
  const e=env(), a=await enroll(e), pending=[]; let calls=0;
  const dispatch=async ()=>{calls++;return {accepted:true,provider:'apns',status:200};};
  const ctx={waitUntil(promise){pending.push(promise);}};
  mock.timers.enable({apis:['setTimeout']});
  try {
    const response=await handle(request(`/v1/devices/${a.id}/test`,'POST',a.credential,{delay:10}),e,dispatch,ctx);
    assert.equal(response.status,202);
    assert.deepEqual(await response.json(),{scheduled:true,delay:10});
    assert.equal(pending.length,1);
    mock.timers.tick(9999); await Promise.resolve(); assert.equal(calls,0);
    mock.timers.tick(1); await Promise.all(pending); assert.equal(calls,1);
  } finally { mock.timers.reset(); }
  assert.throws(()=>delay({delay:21}));
  assert.throws(()=>delay({delay:1.5}));
  assert.equal(delay({}),0);
});
test('token rotation and removal require the device credential',async()=>{
  const e=env(), a=await enroll(e), path=`/v1/devices/${a.id}`;
  const rotated={provider:'fcm',token:'fixture:token'.repeat(4),environment:'production'};
  assert.equal((await handle(request(path,'PUT',a.credential,rotated),e)).status,200);
  assert.equal((await e.DB.prepare('SELECT token FROM devices WHERE id = ?').bind(a.id).first()).token,rotated.token);
  assert.equal((await handle(request(path,'DELETE','x'.repeat(43)),e)).status,401);
  assert.equal((await handle(request(path,'DELETE',a.credential),e)).status,200);
  assert.equal(await e.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(a.id).first(),null);
  assert.equal((await handle(request(path,'DELETE',a.credential),e)).status,404);
});
test('invalid provider tokens are removed and provider exceptions do not leak secrets',async()=>{
  const e=env(), a=await enroll(e), payload={title:'Fixture',body:'Test'};
  const response=await handle(request(`/v1/devices/${a.id}/test`,'POST',admin,payload),e,async()=>({accepted:false,invalidToken:true}));
  assert.equal(response.status,502);
  assert.equal(await e.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(a.id).first(),null);
  const b=await enroll(e);
  const failed=await handle(request(`/v1/devices/${b.id}/test`,'POST',admin,payload),e,async()=>{throw new Error('PRIVATE KEY fixture');});
  assert.equal(failed.status,502);assert.doesNotMatch(await failed.text(),/PRIVATE/);
});
test('validation rejects payload overrides, malformed tokens, and oversized requests',async()=>{
  assert.throws(()=>registration({provider:'apns',environment:'sandbox',token:'../other'}));
  assert.throws(()=>message({title:'T',body:'B',data:{aps:'override'}}));
  assert.throws(()=>message({title:'T',body:'B',data:{'google.test':'override'}}));
  const result=await handle(request('/v1/devices','POST',null,{padding:'x'.repeat(9000)}),env());
  assert.equal(result.status,413);
  assert.deepEqual(apnsPayload({title:'T',body:'B',data:{aps:'bad'}}).aps.alert,{title:'T',body:'B'});
});
test('ES256 and RS256 JWTs verify against generated fixture keys',async()=>{
  for (const algorithm of ['ES256','RS256']) {
    const parameters=algorithm==='ES256'?{name:'ECDSA',namedCurve:'P-256'}:
      {name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
    const keys=await crypto.subtle.generateKey(parameters,true,['sign','verify']);
    const der=await crypto.subtle.exportKey('pkcs8',keys.privateKey);
    const pem=`-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`;
    const jwt=await signJwt(pem,algorithm,{kid:'fixture'},{iss:'fixture',iat:123});
    const [head,body,signature]=jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(head,'base64url')).alg,algorithm);
    assert.equal(await crypto.subtle.verify(algorithm==='ES256'?{name:'ECDSA',hash:'SHA-256'}:parameters,
      keys.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(`${head}.${body}`)),true);
  }
});
