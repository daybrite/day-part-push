<!--
Copyright © The Daybrite Project
SPDX-License-Identifier: MPL-2.0
-->

# day-part-push

Receive push notifications in Day apps. Request permission, register a device, observe token
changes, and handle messages and notification taps. Your server sends through APNs or FCM.

## Add to your app

```sh
cargo add 'day-part-push@0.*'
```

Build with the Day CLI to include native sources and permissions. Configure the app's Apple
capabilities or Firebase client resources using the [setup guide](docs/push.md#native-configuration).
Sender keys belong on your server.

| Feature | Provider | Availability |
| --- | --- | --- |
| `ios-apns` (default) | Apple Push Notification service | iOS / UIKit |
| `android-fcm` (default) | Firebase Cloud Messaging | Android / Material with Google Play services |
| `relay` | Client for the demo relay | Optional; requires a configured relay |

Desktop, web, and HarmonyOS do not have native push providers in this package.

## Listen for notifications

Subscribe before registering and keep the returned watch alive:

```rust
use day_part_push::{self as push, Event};

async fn register() -> Result<push::Watch, push::Error> {
    let watch = push::watch(|event| match event {
        Event::Token { token } => {
            // Send this token to your server, including later rotations.
            let _ = token;
        }
        Event::Message { payload, opened } => {
            // Pass data to the UI through a Day Setter; opened identifies a tap.
            let _ = (payload, opened);
        }
        Event::Error { message } => { let _ = message; }
    })?;
    push::request_permission().await?;
    push::register().await?;
    Ok(watch)
}
```

Callbacks can run off the UI thread. Registration completes through events; a successful send
response does not establish delivery to the device.

## Android without Google dependencies

Disable default features and enable only the providers your app needs:

```toml
[dependencies]
day-part-push = { version = "0.*", default-features = false, features = ["ios-apns"] }
```

This configuration excludes FCM and Google Mobile Services from Android builds. It leaves Android
push unsupported until another provider is added. Cargo features are additive, so check the final
APK as well as the dependency graph. The demo includes `fcm` and `fdroid` build flavors.

## Documentation and examples

- [Permissions, token lifecycle, and platform setup](docs/push.md)
- [Run Push Lab](demo/README.md)
- [Run the Cloudflare demo relay](relay/README.md)
- [CI, crate reservation, and trusted publishing](docs/releases.md)

```sh
cargo test --workspace --all-features
cargo doc --no-deps --open
```

[MPL-2.0 license](LICENSE)
