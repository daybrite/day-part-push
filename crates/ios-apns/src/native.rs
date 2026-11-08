day_bridge::bridge! {
    #[day_bridge::declare]
    extern "day" {
        fn register_native(done: day_bridge::Done<String>) -> Result<(), day_bridge::Error>;
        fn unregister_native(done: day_bridge::Done<String>) -> Result<(), day_bridge::Error>;
    }
    #[day_bridge::impl(swift, platforms = [ios], src = "platform/Push.swift")]
    #[day_bridge::impl(rust, platforms = [other])]
    fn register_native(_done: day_bridge::Done<String>) -> Result<(), day_bridge::Error> { Err(day_bridge::Error::Unsupported) }
    #[day_bridge::impl(rust, platforms = [other])]
    fn unregister_native(_done: day_bridge::Done<String>) -> Result<(), day_bridge::Error> { Err(day_bridge::Error::Unsupported) }
}
