day_bridge::bridge! {
    #[day_bridge::declare]
    extern "day" {
        fn initialize_native() -> Result<(), day_bridge::Error>;
        fn events_native(events: day_bridge::Emit<String>) -> Result<(), day_bridge::Error>;
        fn register_native(done: day_bridge::Done<String>) -> Result<(), day_bridge::Error>;
        fn unregister_native(done: day_bridge::Done<String>) -> Result<(), day_bridge::Error>;
    }
    #[day_bridge::impl(java, platforms = [android], src = "platform/Push.java")]
    #[day_bridge::impl(rust, platforms = [other])]
    fn initialize_native() -> Result<(), day_bridge::Error> { Err(day_bridge::Error::Unsupported) }
    #[day_bridge::impl(rust, platforms = [other])]
    fn events_native(_events: day_bridge::Emit<String>) -> Result<(), day_bridge::Error> { Err(day_bridge::Error::Unsupported) }
    #[day_bridge::impl(rust, platforms = [other])]
    fn register_native(_done: day_bridge::Done<String>) -> Result<(), day_bridge::Error> { Err(day_bridge::Error::Unsupported) }
    #[day_bridge::impl(rust, platforms = [other])]
    fn unregister_native(_done: day_bridge::Done<String>) -> Result<(), day_bridge::Error> { Err(day_bridge::Error::Unsupported) }
}
pub(crate) fn initialize() -> Result<(), day_bridge::Error> {
    initialize_native()
}
