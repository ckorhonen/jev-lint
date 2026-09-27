# relay

A small Tokio service crate. `cargo build` / `cargo test` (works offline once the
dependencies are in the local cargo cache; there is no HTTP client or database crate —
define traits for external services and fake them in tests).

- `src/lib.rs` — library root; add modules here
- `src/main.rs` — binary entry point (`#[tokio::main]`)
- `tests/` — integration tests
