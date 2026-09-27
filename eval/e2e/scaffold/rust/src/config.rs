use std::env;

/// Service configuration read from the environment.
#[derive(Clone)]
pub struct Config {
    pub listen_addr: String,
    pub upstream_url: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            listen_addr: env::var("RELAY_LISTEN").unwrap_or_else(|_| "127.0.0.1:7000".into()),
            upstream_url: env::var("RELAY_UPSTREAM").unwrap_or_else(|_| "http://127.0.0.1:8080".into()),
        }
    }
}
