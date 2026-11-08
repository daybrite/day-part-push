#!/usr/bin/env node
// Local administrator tool. Never bundle this file or private/ with an app.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const [command, ...args] = process.argv.slice(2);
const origin = new URL(process.env.DAY_PUSH_RELAY ?? 'https://push.daybrite.cloud');
if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) ||
    origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('DAY_PUSH_RELAY must be an HTTPS origin or a loopback HTTP origin');
}
async function secrets() {
  return JSON.parse(await readFile(new URL('private/worker-secrets.json', import.meta.url), 'utf8'));
}
async function request(path, method = 'GET', body, authorization) {
  const response = await fetch(new URL(path, origin), {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Relay HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
async function run(...args) {
  await new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Wrangler exited with ${code}`)));
  });
}
try {
  if (command === 'health') {
    console.log(await request('/health'));
  } else if (command === 'dev') {
    const local = await secrets();
    // JSON quoting preserves PEM newlines in Wrangler's dotenv file.
    await writeFile(new URL('.dev.vars', import.meta.url), Object.entries(local).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
    await run('d1', 'execute', 'daybrite-push', '--local', '--file=schema.sql');
    await run('dev', '--ip', '127.0.0.1');
  } else if (command === 'enroll') {
    const admin = process.env.DAY_PUSH_ADMIN_TOKEN ?? (await secrets()).ADMIN_TOKEN;
    const enrollment = await request('/v1/enrollments', 'POST', undefined, admin);
    if (args[0]) {
      await writeFile(args[0], JSON.stringify(enrollment) + '\n', { mode: 0o600, flag: 'wx' });
      console.log('Enrollment code saved; expires in ten minutes.');
    } else console.log(JSON.stringify(enrollment, null, 2));
  } else if (command === 'send' || command === 'remove') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args[0] ?? '')) throw new Error('Supply a registration UUID');
    const admin = process.env.DAY_PUSH_ADMIN_TOKEN ?? (await secrets()).ADMIN_TOKEN;
    if (command === 'remove') console.log(await request(`/v1/devices/${args[0]}`, 'DELETE', undefined, admin));
    else {
      if (args.length !== 3) throw new Error('Usage: node manage.mjs send UUID "title" "body"');
      console.log(await request(`/v1/devices/${args[0]}/test`, 'POST', { title: args[1], body: args[2] }, admin));
    }
  } else throw new Error('Usage: node manage.mjs health | dev | enroll [new-file.json] | send UUID "title" "body" | remove UUID');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
