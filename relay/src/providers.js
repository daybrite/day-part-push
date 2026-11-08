const encoder = new TextEncoder();
const cache = new Map();
export function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function encoded(value) { return base64url(encoder.encode(JSON.stringify(value))); }
export async function signJwt(pem, algorithm, header, claims) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  const parameters = algorithm === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('pkcs8', keyBytes, parameters, false, ['sign']);
  const data = `${encoded({ alg: algorithm, ...header })}.${encoded(claims)}`;
  const signature = await crypto.subtle.sign(algorithm === 'ES256'
    ? { name: 'ECDSA', hash: 'SHA-256' } : parameters, key, encoder.encode(data));
  return `${data}.${base64url(signature)}`;
}
async function apnsAuthorization(env) {
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.get('apns');
  if (cached?.secret === env.APNS_PRIVATE_KEY && cached.until > now) return cached.value;
  const value = await signJwt(env.APNS_PRIVATE_KEY, 'ES256', { kid: env.APNS_KEY_ID }, { iss: env.APNS_TEAM_ID, iat: now });
  cache.set('apns', { secret: env.APNS_PRIVATE_KEY, value, until: now + 3000 });
  return value;
}
async function fcmAuthorization(env, transport) {
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.get('fcm');
  if (cached?.secret === env.FCM_SERVICE_ACCOUNT && cached.until > now) return cached.value;
  const account = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  if (account.project_id !== env.FCM_PROJECT_ID) throw new Error('FCM project mismatch');
  const endpoint = 'https://oauth2.googleapis.com/token';
  const assertion = await signJwt(account.private_key, 'RS256', { typ: 'JWT' }, {
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: endpoint, iat: now, exp: now + 3600,
  });
  const response = await transport(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15000), redirect: 'manual',
  });
  if (!response.ok) throw new Error('FCM authentication failed');
  const result = await response.json();
  if (typeof result.access_token !== 'string') throw new Error('Invalid FCM authentication response');
  cache.set('fcm', { secret: env.FCM_SERVICE_ACCOUNT, value: result.access_token, until: now + Math.min(3000, result.expires_in - 120) });
  return result.access_token;
}
export function apnsPayload(message) {
  return { ...message.data, aps: { alert: { title: message.title, body: message.body }, sound: 'default' } };
}
export async function send(env, device, message, transport = fetch) {
  let response;
  if (device.provider === 'apns') {
    const host = device.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    response = await transport(`https://${host}/3/device/${device.token}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { authorization: `bearer ${await apnsAuthorization(env)}`, 'content-type': 'application/json',
        'apns-topic': env.APNS_TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': '0' },
      body: JSON.stringify(apnsPayload(message)),
    });
  } else {
    response = await transport(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${await fcmAuthorization(env, transport)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: device.token, notification: { title: message.title, body: message.body },
        data: message.data, android: { priority: 'HIGH', ttl: '60s', restricted_package_name: env.APNS_TOPIC } } }),
    });
  }
  // Provider acceptance is not confirmation that a device displayed the notification.
  if (response.ok) return { accepted: true, provider: device.provider, status: response.status };
  const result = await response.json().catch(() => ({}));
  const code = device.provider === 'apns' ? result.reason : result.error?.details?.find(v => v.errorCode)?.errorCode;
  return { accepted: false, provider: device.provider, status: response.status,
    code: typeof code === 'string' ? code : 'ProviderRejected',
    invalidToken: code === 'Unregistered' || code === 'BadDeviceToken' || code === 'UNREGISTERED' };
}
