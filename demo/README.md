# Push Lab

Register for notifications, inspect token changes, and observe incoming messages and taps with
[day-part-push](../README.md).

From this directory:

```sh
day launch -t ios-uikit --script dayscript/demo.yaml
day launch -t android-material --flavor fcm --script dayscript/demo.yaml
day build -t android-material --flavor fdroid
```

The portable walkthrough checks the UI without registration or production credentials.
For delivery tests, configure Apple capabilities or Firebase resources for the demo's identifier,
`dev.daybrite.push.demo`, following the [native setup guide](../docs/push.md#native-configuration).
Day-Showcase's configuration belongs to a different app and cannot substitute for it.

The `fdroid` flavor excludes FCM and Google Mobile Services, leaving Android push unsupported.
It demonstrates dependency exclusion, not certification of the complete app for F-Droid.
From the package root, run `python3 ci/check-providers.py` to build FCM and then the Google-free
flavor and inspect both APKs. Set `DAY_BIN` to select a specific Day CLI.

UI strings are localized in `resource/locales/`. Keep sender credentials on the server; see the
[Cloudflare relay](../relay/README.md) for the Day-Showcase registration and sending example.
