//! Native transport backend. Most apps use this through `day-part-push`.
mod native;
pub fn register() -> day_bridge::Completion<String> {
    native::register_native_future()
}
pub fn unregister() -> day_bridge::Completion<String> {
    native::unregister_native_future()
}
use std::sync::{Arc, Mutex};
type Callback = Arc<dyn Fn(String) + Send + Sync>;
static CALLBACK: Mutex<Option<Callback>> = Mutex::new(None);
/// Route native push events to `callback`.
///
/// # Errors
///
/// Never fails; the `Result` matches the other transports' `start`.
pub fn start(callback: impl Fn(String) + Send + Sync + 'static) -> Result<(), day_bridge::Error> {
    *CALLBACK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::new(callback));
    day_part_local_notify::prepare_delivery();
    Ok(())
}
#[cfg(target_os = "ios")]
fn deliver(value: &serde_json::Value) {
    let callback = CALLBACK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Some(callback) = callback {
        callback(value.to_string());
    }
}
#[cfg(target_os = "ios")]
#[day_process::linkme::distributed_slice(day_process::services::NOTIFICATION_HANDLERS)]
#[linkme(crate = day_process::linkme)]
static NOTIFICATIONS: fn(&day_process::services::NotificationEvent) = |event| {
    use day_process::services::NotificationEvent as Native;
    use serde_json::json;
    use std::fmt::Write as _;
    match event {
        Native::Registered(bytes) => {
            let value = bytes.iter().fold(String::new(), |mut hex, b| {
                let _ = write!(hex, "{b:02x}");
                hex
            });
            deliver(&json!({"event":"token", "token":{"provider":"apns", "value":value}}));
        }
        Native::RegistrationFailed(message) => {
            deliver(&json!({"event":"error", "message":message}));
        }
        Native::Received { payload, opened } => {
            match serde_json::from_str::<serde_json::Value>(payload) {
                Ok(payload) => {
                    deliver(&json!({"event":"message", "payload":payload, "opened":opened}));
                }
                Err(error) => deliver(&json!({"event":"error", "message":error.to_string()})),
            }
        }
    }
};
