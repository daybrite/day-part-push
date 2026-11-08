# day-part-push-ios-apns

The iOS provider for Day push notifications. Applications normally use this crate through
`day-part-push` with its `ios-apns` feature, which is enabled by default.

```toml
[dependencies]
day-part-push = { version = "0.*", default-features = false, features = ["ios-apns"] }
```

Configure Push Notifications for the app identifier and include `aps-environment` in the signed
entitlements. The provider shares Day's notification delegate with local notifications.

Build with the Day CLI to stage the native integration. Sender credentials belong on the server.

See the [push setup guide](https://daybrite.dev/docs/reference/push) and
[release instructions](https://github.com/daybrite/day-part-push/blob/main/docs/releases.md).
