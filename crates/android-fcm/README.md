# day-part-push-android-fcm

The Android provider for Day push notifications. Applications normally use this crate through
`day-part-push` with its `android-fcm` feature, which is enabled by default.

```toml
[dependencies]
day-part-push = { version = "0.*", default-features = false, features = ["android-fcm"] }
```

This provider adds Firebase Messaging and Google Play services to Android builds. Apps that
exclude Google dependencies must leave this feature disabled across their entire dependency graph.

Build with the Day CLI to stage the native integration. Sender credentials belong on the server.

See the [push setup guide](https://daybrite.dev/docs/reference/push) and
[release instructions](https://github.com/daybrite/day-part-push/blob/main/docs/releases.md).
