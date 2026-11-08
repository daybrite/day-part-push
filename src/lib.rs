// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

//! APNs and FCM registration and delivery. Sender credentials belong on your server.
//! Call `watch` before `register`; token changes arrive as events and must be sent to your server.

#[cfg(all(target_os = "android", feature = "android-fcm"))]
use day_part_push_android_fcm as backend;
#[cfg(all(target_os = "ios", feature = "ios-apns"))]
use day_part_push_ios_apns as backend;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(any(
    all(target_os = "ios", feature = "ios-apns"),
    all(target_os = "android", feature = "android-fcm")
)))]
mod backend {
    static REQUESTS: day_bridge::Registry<String> = day_bridge::Registry::new();
    pub fn start(_: impl Fn(String) + Send + Sync + 'static) -> Result<(), day_bridge::Error> {
        Err(day_bridge::Error::Unsupported)
    }
    pub fn register() -> day_bridge::Completion<String> {
        day_bridge::start_future(&REQUESTS, |_| Err(day_bridge::Error::Unsupported))
    }
    pub fn unregister() -> day_bridge::Completion<String> {
        register()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Unsupported,
    PermissionDenied,
    /// HTTP status from the optional relay; response bodies are not echoed.
    RelayStatus(u16),
    Platform(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Apns,
    Fcm,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Token {
    pub provider: Provider,
    pub value: String,
}
impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Token")
            .field("provider", &self.provider)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Token {
        token: Token,
    },
    Message {
        payload: serde_json::Value,
        opened: bool,
    },
    Error {
        message: String,
    },
}

type Listener = Arc<Subscriber>;
struct Subscriber {
    callback: Box<dyn Fn(Event) + Send + Sync>,
    state: Mutex<DeliveryQueue>,
}
#[derive(Default)]
struct DeliveryQueue {
    pending: VecDeque<Event>,
    running: bool,
}
impl Subscriber {
    fn enqueue(&self, event: Event) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .push_back(event);
    }
    fn drain(&self) {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.running {
                return;
            }
            state.running = true;
        }
        loop {
            let event = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                match state.pending.pop_front() {
                    Some(event) => event,
                    None => {
                        state.running = false;
                        return;
                    }
                }
            };
            // Callbacks can subscribe, unsubscribe, or trigger another event without holding a hub lock.
            if let Err(panic) =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.callback)(event)))
            {
                self.state.lock().unwrap_or_else(|e| e.into_inner()).running = false;
                std::panic::resume_unwind(panic);
            }
        }
    }
}
#[derive(Default)]
struct Hub {
    next: u64,
    listeners: BTreeMap<u64, Listener>,
    token: Option<Token>,
    recent: VecDeque<Event>,
}
static HUB: OnceLock<Mutex<Hub>> = OnceLock::new();
fn hub() -> &'static Mutex<Hub> {
    HUB.get_or_init(Mutex::default)
}
fn deliver(event: Event) {
    let listeners = {
        let mut hub = hub().lock().unwrap_or_else(|e| e.into_inner());
        if let Event::Token { token } = &event {
            hub.token = Some(token.clone());
        } else {
            if hub.recent.len() == 32 {
                hub.recent.pop_front();
            }
            hub.recent.push_back(event.clone());
        }
        let listeners = hub.listeners.values().cloned().collect::<Vec<_>>();
        for listener in &listeners {
            listener.enqueue(event.clone());
        }
        listeners
    };
    for listener in listeners {
        listener.drain();
    }
}

pub struct Watch(u64);
impl Drop for Watch {
    fn drop(&mut self) {
        hub()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .listeners
            .remove(&self.0);
    }
}

/// Subscribe to token changes and messages. Replays the last token and up to 32 recent events,
/// including notification taps received before the UI mounted. Callbacks may run off the UI thread.
pub fn watch(callback: impl Fn(Event) + Send + Sync + 'static) -> Result<Watch, Error> {
    start()?;
    let listener = Arc::new(Subscriber {
        callback: Box::new(callback),
        state: Mutex::default(),
    });
    let id = {
        let mut hub = hub().lock().unwrap_or_else(|e| e.into_inner());
        hub.next += 1;
        let id = hub.next;
        let mut replay = Vec::new();
        if let Some(token) = &hub.token {
            replay.push(Event::Token {
                token: token.clone(),
            });
        }
        replay.extend(hub.recent.iter().cloned());
        for event in replay {
            listener.enqueue(event);
        }
        hub.listeners.insert(id, listener.clone());
        id
    };
    listener.drain();
    Ok(Watch(id))
}

pub fn supported() -> bool {
    cfg!(any(
        all(target_os = "ios", feature = "ios-apns"),
        all(target_os = "android", feature = "android-fcm")
    ))
}

/// Ask for visible notification permission separately from transport registration.
pub async fn request_permission() -> Result<(), Error> {
    if !supported() {
        return Err(Error::Unsupported);
    }
    use day_part_permissions::{Permission, Status};
    match day_part_permissions::request_future(Permission::Notifications).await {
        Status::Granted => Ok(()),
        Status::Unsupported => Err(Error::Unsupported),
        _ => Err(Error::PermissionDenied),
    }
}

/// Start native token registration. Completion means the request was accepted; `Event::Token`
/// carries the token. Apple requires a push entitlement; Android requires Firebase app resources.
pub async fn register() -> Result<(), Error> {
    start()?;
    answer(backend::register().await.map_err(bridge_error)?)
}
pub async fn unregister() -> Result<(), Error> {
    start()?;
    answer(backend::unregister().await.map_err(bridge_error)?)?;
    hub().lock().unwrap_or_else(|e| e.into_inner()).token = None;
    Ok(())
}
fn start() -> Result<(), Error> {
    if !supported() {
        return Err(Error::Unsupported);
    }
    static STARTED: OnceLock<Result<(), Error>> = OnceLock::new();
    STARTED
        .get_or_init(|| {
            backend::start(|value| match serde_json::from_str(&value) {
                Ok(event) => deliver(event),
                Err(error) => deliver(Event::Error {
                    message: error.to_string(),
                }),
            })
            .map_err(bridge_error)
        })
        .clone()
}
fn answer(value: String) -> Result<(), Error> {
    if value.is_empty() {
        Ok(())
    } else {
        Err(Error::Platform(value))
    }
}
fn bridge_error(error: day_bridge::Error) -> Error {
    if matches!(error, day_bridge::Error::Unsupported) {
        Error::Unsupported
    } else {
        Error::Platform(error.to_string())
    }
}

#[cfg(any(
    all(target_os = "ios", feature = "ios-apns"),
    all(target_os = "android", feature = "android-fcm")
))]
#[day_core::linkme::distributed_slice(day_core::services::SERVICES)]
#[linkme(crate = day_core::linkme)]
static SERVICE: day_core::services::Service = day_core::services::Service {
    name: "push",
    initialize: || {
        if let Err(error) = start() {
            deliver(Event::Error {
                message: error.to_string(),
            });
        }
    },
};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_precedes_concurrent_delivery_and_callbacks_are_serial() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let observed = seen.clone();
        let listener = Arc::new(Subscriber {
            callback: Box::new(move |event| {
                let Event::Error { message } = event else {
                    unreachable!()
                };
                if message == "replay" {
                    entered_tx.send(()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                }
                observed.lock().unwrap().push(message);
            }),
            state: Mutex::default(),
        });
        listener.enqueue(Event::Error {
            message: "replay".into(),
        });
        let first = listener.clone();
        let thread = std::thread::spawn(move || first.drain());
        entered_rx.recv().unwrap();
        listener.enqueue(Event::Error {
            message: "new".into(),
        });
        listener.drain();
        assert!(seen.lock().unwrap().is_empty());
        release_tx.send(()).unwrap();
        thread.join().unwrap();
        assert_eq!(*seen.lock().unwrap(), ["replay", "new"]);
    }
    #[test]
    fn token_debug_does_not_disclose_device_identifier() {
        let token = Token {
            provider: Provider::Fcm,
            value: "synthetic-sensitive-token".into(),
        };
        assert!(!format!("{token:?}").contains(&token.value));
    }
    #[test]
    fn provider_and_opened_state_survive_native_delivery() {
        let event: Event =
            serde_json::from_str(r#"{"event":"message","opened":true,"payload":{"id":"fixture"}}"#)
                .unwrap();
        assert!(matches!(event, Event::Message { opened: true, .. }));
        let event: Event = serde_json::from_str(
            r#"{"event":"token","token":{"provider":"apns","value":"fixture"}}"#,
        )
        .unwrap();
        assert!(matches!(
            event,
            Event::Token {
                token: Token {
                    provider: Provider::Apns,
                    ..
                }
            }
        ));
    }
}

#[cfg(feature = "relay")]
pub mod relay;
