// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0
// What the relay allows. Kept apart from worker.js because the Workers runtime treats every
// export of the main module as an entry point.
export class Problem extends Error { constructor(status, message) { super(message); this.status = status; } }
// Registrations anyone can create are bounded three ways: per network per hour, in total, and in
// age. A registration unused (no token update, no send) for this long is removed.
export const REGISTRATION_SECONDS = 7 * 24 * 60 * 60;
export const REGISTRATIONS_PER_NETWORK_HOUR = 10;
export const MAX_REGISTRATIONS = 5000;
export const SEND_INTERVAL_SECONDS = 30;
// What a device-credential send delivers. Only the administrator chooses notification text, so a
// device token obtained by someone else can receive nothing but this sample. The languages match
// Day-Showcase's catalogs.
const SAMPLES = {
  en: { title: 'Hello from Day', body: "This notification traveled through the Day relay and your device's push service." },
  fr: { title: 'Bonjour de la part de Day', body: "Cette notification est passée par le relais Day et le service push de votre appareil." },
  ar: { title: 'مرحبًا من Day', body: 'وصل هذا الإشعار عبر خدمة ترحيل Day وخدمة الإشعارات في جهازك.' },
  'zh-CN': { title: '来自 Day 的问候', body: '此通知通过 Day 中继服务和设备的推送服务发送。' },
};
// The sample in the language closest to a BCP 47 tag: the exact catalog, then its language, then
// English.
export function sample(locale) {
  if (locale !== undefined && (typeof locale !== 'string' || !/^[A-Za-z0-9_-]{1,35}$/.test(locale))) {
    throw new Problem(400, 'Invalid locale');
  }
  const tag = (locale ?? '').replaceAll('_', '-').toLowerCase();
  const key = Object.keys(SAMPLES).find(k => k.toLowerCase() === tag) ??
    Object.keys(SAMPLES).find(k => k.split('-')[0] === tag.split('-')[0]) ?? 'en';
  return { ...SAMPLES[key], data: { 'day.demo': 'push' } };
}
// The rate-limit key for an enrollment: the client's IPv4 address, or its IPv6 /64, since one
// IPv6 host can use any address in its prefix. Cloudflare sets the header; without it (local
// tests) every caller shares one bucket.
export function network(request) {
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  if (!ip.includes(':')) return ip || 'unknown';
  const [head, tail] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
