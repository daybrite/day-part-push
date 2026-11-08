import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handle, digest, registration, message } from '../src/worker.js';
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
function request(path, method, token, value) {
  return new Request('https://push.example.test' + path, { method,
    headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}
async function enroll(environment) {
  const code = await (await handle(request('/v1/enrollments','POST',admin),environment)).json();
  const response = await handle(request('/v1/devices','POST',null,{
    code: code.code, provider:'apns', token:'a'.repeat(64), environment:'sandbox',
  }),environment);
  assert.equal(response.status,201);
  return { ...await response.json(), code: code.code };
}
test('registration requires a one-use, expiring enrollment code', async () => {
  const e=env(), device=await enroll(e);
  const replay=await handle(request('/v1/devices','POST',null,{
    code:device.code,provider:'apns',token:'b'.repeat(64),environment:'sandbox',
  }),e);
  assert.equal(replay.status,401);
  assert.equal((await handle(request('/v1/enrollments','POST','b'.repeat(43)),e)).status,401);
  const expired='c'.repeat(43);
  await e.DB.prepare('INSERT INTO enrollments(digest,expires) VALUES (?,?)').bind(await digest(expired),0).run();
  assert.equal((await handle(request('/v1/devices','POST',null,{
    code:expired,provider:'apns',token:'a'.repeat(64),environment:'sandbox',
  }),e)).status,401);
});
test('a device can send only to its registration and sends are rate limited',async()=>{
  const e=env(), a=await enroll(e), b=await enroll(e); let calls=0;
  const dispatch=async (_env,device,payload)=>{
    calls++;assert.equal(device.id,a.id);assert.equal(payload.title,'Fixture');return {accepted:true,provider:'apns',status:200};
  };
  const payload={title:'Fixture',body:'Synthetic test message'};
  assert.equal((await handle(request(`/v1/devices/${a.id}/test`,'POST',b.credential,payload),e,dispatch)).status,401);
  assert.equal((await handle(request(`/v1/devices/${a.id}/test`,'POST',a.credential,payload),e,dispatch)).status,200);
  assert.equal((await handle(request(`/v1/devices/${a.id}/test`,'POST',a.credential,payload),e,dispatch)).status,429);
  assert.equal(calls,1);
});
test('token rotation and removal require the device credential',async()=>{
  const e=env(), a=await enroll(e), path=`/v1/devices/${a.id}`;
  const rotated={provider:'fcm',token:'fixture:token'.repeat(4),environment:'production'};
  assert.equal((await handle(request(path,'PUT',a.credential,rotated),e)).status,200);
  assert.equal((await e.DB.prepare('SELECT token FROM devices WHERE id = ?').bind(a.id).first()).token,rotated.token);
  assert.equal((await handle(request(path,'DELETE','x'.repeat(43)),e)).status,401);
  assert.equal((await handle(request(path,'DELETE',a.credential),e)).status,200);
  assert.equal(await e.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(a.id).first(),null);
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
