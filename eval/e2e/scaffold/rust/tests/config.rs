use relay::config::Config;

#[test]
fn defaults_listen_on_localhost() {
    std::env::remove_var("RELAY_LISTEN");
    assert_eq!(Config::from_env().listen_addr, "127.0.0.1:7000");
}
