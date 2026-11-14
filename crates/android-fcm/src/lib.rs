//! Native transport backend. Most apps use this through `day-part-push`.
mod native;
pub fn register() -> day_bridge::Completion<String> {
    native::register_native_future()
}
pub fn unregister() -> day_bridge::Completion<String> {
    native::unregister_native_future()
}
/// Route native push events to `callback` and initialize Firebase Messaging.
///
/// # Errors
///
/// Returns [`day_bridge::Error::Unsupported`] off Android, and the bridge's error when the
/// native side cannot initialize.
pub fn start(callback: impl Fn(String) + Send + Sync + 'static) -> Result<(), day_bridge::Error> {
    native::events_native_stream(move |event| {
        if let day_bridge::Item::Value(value) = event {
            callback(value);
        }
    })?;
    native::initialize()
}
