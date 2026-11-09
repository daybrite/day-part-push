# Day push relay

A Cloudflare Worker sends test notifications to enrolled Day-Showcase installations through APNs or FCM. D1 stores device registrations. The relay has no dashboard or public broadcast endpoint.

```mermaid
sequenceDiagram
    participant Admin as Local administrator
    participant App as Day-Showcase
    participant Relay as Cloudflare Worker + D1
    participant Provider as APNs / FCM
    Admin->>Relay: Create enrollment code (admin credential)
    Relay-->>Admin: One use, expires in 10 minutes
    Admin-->>App: Enter code
    App->>Relay: Code + device token
    Relay-->>App: Per-device credential
    App->>Relay: Send test (per-device credential)
    Relay->>Provider: Signed send request
    Provider-->>App: Notification
    Relay-->>App: Provider acceptance or rejection
```

A device credential can update, send to, or remove only that registration. Test sends are limited to one every 30 seconds per device. A test send can ask the relay to wait up to 20 seconds first (`delay`, in seconds); the relay then answers `202` at once and sends from `waitUntil`, so a provider rejection after the delay is not reported to the app. Enrollment codes and device credentials are stored as hashes. Device tokens are stored in D1 so the sender can use them. Remove a registration when it is no longer needed; APNs/FCM invalid-token responses also remove it.

## Run locally

Requires Node with `node:sqlite` support, npm, and a Cloudflare account for deployment.

```sh
npm ci
npm test
node manage.mjs dev
```

The local server binds to `127.0.0.1:8787`, applies `schema.sql` to local D1, and reads sender credentials from the ignored `private/worker-secrets.json`. Local sends use the real provider APIs. A phone cannot reach the host's loopback interface; use the deployed HTTPS relay for device tests.

The secrets file has three keys:

- `ADMIN_TOKEN`: a random 32-byte base64url administrator credential.
- `APNS_PRIVATE_KEY`: the PEM text of the Apple `.p8` signing key.
- `FCM_SERVICE_ACCOUNT`: the JSON text of a dedicated service-account key with the Firebase Cloud Messaging API Admin role.

Keep this file owner-readable only. The client `google-services.json` cannot send notifications and is not a substitute for the service-account key. Never put administrator or sender credentials in an app bundle.

## Deploy

Set the account, custom domain, APNs team/key/topic, Firebase project, and D1 binding in `wrangler.toml`. The checked-in configuration targets `push.daybrite.cloud` and `dev.daybrite.showcase`.

```sh
npx wrangler login
npx wrangler d1 execute daybrite-push --remote --file=schema.sql
npx wrangler deploy --secrets-file private/worker-secrets.json
node manage.mjs health
```

For a new account, create the D1 database first with `wrangler d1 create daybrite-push` and copy its ID into the configuration. Later deployments can use `npm run deploy`; existing Worker secrets are preserved.

APNs sandbox and production use different device tokens. Select the environment matching the app's signed entitlement. The relay restricts FCM delivery to the configured app identifier and checks that the service-account project matches `FCM_PROJECT_ID`.

## Enroll and send

```sh
node manage.mjs enroll
# Or save the one-use code without printing it:
node manage.mjs enroll private/enrollment.json
```

In Day-Showcase, open **Push notifications**, enter the code, and tap **Send now** or **Send in 10 seconds**. The first send asks for notification permission, waits for the device token, and registers the device with the relay. Later sends need only the tap. Use the delayed send to leave the app or lock the device and see how the notification arrives in the background. Development builds use the APNs sandbox; the switch is under **Advanced**.

The app updates its registration when the device token changes. **Advanced → Remove from relay** deletes the server registration and local credential. It does not turn off the OS notification permission.

An administrator can also send or remove a known registration:

```sh
node manage.mjs send REGISTRATION_UUID "Hello from Day" "A test notification"
node manage.mjs remove REGISTRATION_UUID
```

Set `DAY_PUSH_RELAY` to use another HTTPS origin, or `http://127.0.0.1:8787` for local development. `DAY_PUSH_ADMIN_TOKEN` overrides the local secrets file for administrator commands.

## Limits

This is a development relay, not an account notification service. Enrollment requires an administrator, credentials authorize one device, and there are no user accounts, topics, delivery receipts, scheduling beyond the 20-second test delay, or automatic retention policy. Provider acceptance is reported separately from device delivery. Payloads are limited to 3 KB; arbitrary provider options are not accepted.

Tests cover enrollment reuse and expiry, device isolation, rate limits, token changes, removal, payload validation, signing, and both providers in the Workers runtime with synthetic keys and network responses. They send no real notifications.
