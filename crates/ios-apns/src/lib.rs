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
pub fn start(callback: impl Fn(String) + Send + Sync + 'static) -> Result<(), day_bridge::Error> {
    *CALLBACK.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(callback));
    day_part_local_notify::prepare_delivery();
    Ok(())
}
#[cfg(target_os = "ios")]
fn deliver(value: serde_json::Value) {
    let callback = CALLBACK.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(callback) = callback {
        callback(value.to_string());
    }
}
#[cfg(target_os = "ios")]
#[day_core::linkme::distributed_slice(day_core::services::NOTIFICATION_HANDLERS)]
#[linkme(crate = day_core::linkme)]
static NOTIFICATIONS: fn(&day_core::services::NotificationEvent) = |event| {
    use day_core::services::NotificationEvent as Native;
    use serde_json::json;
    match event {
        Native::Registered(bytes) => deliver(json!({"event":"token", "token":{"provider":"apns",
            "value":bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()}})),
        Native::RegistrationFailed(message) => deliver(json!({"event":"error", "message":message})),
        Native::Received { payload, opened } => {
            match serde_json::from_str::<serde_json::Value>(payload) {
                Ok(payload) => {
                    deliver(json!({"event":"message", "payload":payload, "opened":opened}))
                }
                Err(error) => deliver(json!({"event":"error", "message":error.to_string()})),
            }
        }
    }
};
