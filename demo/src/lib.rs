use day::prelude::*;
use day_part_push as push;

day::resources!();
day::day_start!(options: res::window_options(), root);

pub fn root() -> impl Piece {
    let token = Signal::new(None::<push::Token>);
    let latest = Signal::new(None::<push::Event>);
    let status = Signal::new(res::str::ready().format());
    let token_setter = token.setter();
    let event_setter = latest.setter();
    match push::watch(move |event| {
        if let push::Event::Token { token } = &event {
            token_setter.set(Some(token.clone()));
        }
        event_setter.set(Some(event));
    }) {
        Ok(watch) => Scope::current().on_cleanup(move || drop(watch)),
        Err(_) => status.set(res::str::unavailable().format()),
    }
    scroll(
        column((
            label(res::str::app_title())
                .font(Font::Title)
                .id(day::id!(title)),
            label(res::str::intro()),
            label(if push::supported() {
                res::str::supported()
            } else {
                res::str::unavailable()
            })
            .id(day::id!(support)),
            button(res::str::register())
                .id(day::id!(register))
                .action(move || {
                    day::task(async move {
                        let result = async {
                            push::request_permission().await?;
                            push::register().await
                        }
                        .await;
                        status.set(match result {
                            Ok(()) => res::str::registration_requested().format(),
                            Err(error) => res::str::operation_error(error.to_string()).format(),
                        });
                    });
                }),
            button(res::str::unregister())
                .id(day::id!(unregister))
                .action(move || {
                    day::task(async move {
                        status.set(match push::unregister().await {
                            Ok(()) => {
                                token.set(None);
                                res::str::unregistered().format()
                            }
                            Err(error) => res::str::operation_error(error.to_string()).format(),
                        });
                    });
                }),
            label(status).id(day::id!(status)),
            label(move || match token.get() {
                Some(value) => res::str::token_received(match value.provider {
                    push::Provider::Apns => "APNs",
                    push::Provider::Fcm => "FCM",
                })
                .format(),
                None => res::str::no_token().format(),
            })
            .id(day::id!(token_state)),
            button(res::str::copy_token())
                .id(day::id!(copy_token))
                .action(move || {
                    if let Some(value) = token.get() {
                        day::clipboard::set_text(&value.value);
                    }
                }),
            label(move || match latest.get() {
                Some(push::Event::Message { payload, opened }) => {
                    let json = serde_json::to_string_pretty(&payload).unwrap_or_default();
                    if opened {
                        res::str::opened_message(json).format()
                    } else {
                        res::str::received_message(json).format()
                    }
                }
                Some(push::Event::Error { message }) => res::str::operation_error(message).format(),
                _ => res::str::waiting_message().format(),
            })
            .id(day::id!(message)),
        ))
        .spacing(Space::M)
        .padding(Space::L),
    )
}
