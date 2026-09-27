# Rust candidates

The compiler and clippy already catch a lot. These candidates target intent: blocking
inside async code, panics on data the program does not control, lost errors and needless
allocation. Leave out what clippy covers. `await_holding_lock` covers std mutex guards
held across `.await`, `map_entry` covers get-then-insert, and `needless_collect` covers
needless collects. Validate each candidate on labeled cases before enabling it.

```json
{
  "id": "rs-blocking-call-in-async",
  "question": "Does `added_code` make a blocking call directly inside an `async fn` or `async` block — `std::thread::sleep`, `std::fs::*`, `std::net`, `reqwest::blocking`, a synchronous DB client, heavy CPU work, or `block_on(...)` — instead of the async equivalent or `tokio::task::spawn_blocking`?",
  "true": "Async code performs blocking I/O, sleeps the thread, or calls block_on, stalling the executor.",
  "false": "It uses async APIs (`tokio::time::sleep`, `tokio::fs`, async reqwest/sqlx) or moves blocking work into `spawn_blocking` / `block_in_place`; or the blocking call is in a normal `fn`. Brief in-memory work and logging do not count.",
  "fix": "Use the async API or move the blocking work into `tokio::task::spawn_blocking`.",
  "when": ["async"]
}
```
Skip if: the crate has no async code.

```json
{
  "id": "rs-unwrap-external-input",
  "question": "Does `added_code` call `.unwrap()` or `.expect(...)` on a result that depends on data the program does not control — parsing user or network input (`parse`, `serde_json::from_*`, `from_utf8`), reading env vars, files, or sockets, or a request/response — in non-test code?",
  "true": "Untrusted or environmental data can make the program panic through unwrap/expect.",
  "false": "Errors are propagated with `?`, matched, or given a default (`unwrap_or`, `unwrap_or_default`); or unwrap is on a value that cannot fail (a literal regex, a constant parse, a lock that is not poisoned by design); or the code is a test, example, or `build.rs`.",
  "fix": "Propagate the error with `?` (or handle it) instead of unwrapping external data.",
  "when": ["unwrap\\(|expect\\("]
}
```
Skip if: `clippy::unwrap_used` / `clippy::expect_used` are denied in non-test code.

```json
{
  "id": "rs-clone-in-loop",
  "question": "Does `added_code` call `.clone()` on a `String`, `Vec`, `HashMap`, or other heap-owning struct inside a loop body where the clone is only read or passed to a function that could take a reference (`&T` / `&str`), so each iteration allocates a copy it doesn't need?",
  "true": "A loop clones an owned, heap-allocated value every iteration although a borrow would work.",
  "false": "The clone is of an `Rc`/`Arc` handle or a `Copy`/cheap type, the cloned value is moved into something that must own it (pushed into a collection, sent to a thread or task, stored in a struct), or no clone happens inside a loop.",
  "fix": "Borrow instead of cloning (`&item`, `&str`), or clone once outside the loop.",
  "when": ["clone\\(\\)"]
}
```
Skip if: the code is not performance sensitive and the team prefers clarity over removing allocations.

```json
{
  "id": "rs-spawned-task-error-lost",
  "question": "Does `added_code` call `tokio::spawn` (or `thread::spawn`) with a task that can fail — its body uses `?` or returns a `Result` — while dropping the returned `JoinHandle` and not logging the error inside the task, so any failure disappears silently?",
  "true": "A fallible spawned task's handle is discarded and its error is neither logged nor handled.",
  "false": "The JoinHandle is stored and awaited, the task is added to a `JoinSet`/`TaskTracker`, or the task logs or handles its own errors (`if let Err(e) = ... { error!(...) }`); or the task cannot fail.",
  "fix": "Await or track the JoinHandle, or log the error inside the task.",
  "when": ["spawn"]
}
```
Skip if: the repo has a spawn helper that already logs task errors, and the rule would flag calls to it.

```json
{
  "id": "rs-string-error-type",
  "question": "Does `added_code` define a public function or method that returns `Result<_, String>` or `Result<_, &str>`, so callers can only read an error message instead of matching on a typed error?",
  "true": "A public API uses a plain string as its error type.",
  "false": "Errors use an enum or struct implementing `std::error::Error` (e.g. via `thiserror`), or `anyhow::Result` in application (binary) code; or the function is private; or no `Result<_, String>` is returned.",
  "fix": "Return a typed error (an enum with thiserror) instead of String.",
  "when": ["Result<"]
}
```
Skip if: the crate is a small binary or script where stringly errors are accepted.

```json
{
  "id": "rs-discarded-io-result",
  "question": "Does `added_code` discard the `Result` of an operation that can meaningfully fail — writing or flushing a file or socket, `fs::remove_file`/`rename`/`create_dir`, sending on a channel, committing a transaction — with `let _ = ...` or a trailing `.ok();`, and no comment explaining why failure is acceptable?",
  "true": "A fallible side effect's error is thrown away silently.",
  "false": "The result is handled, propagated with `?`, or logged; or a comment explains why ignoring it is safe (e.g. the receiver may already be gone during shutdown); or the discarded value is not a fallible side effect.",
  "fix": "Propagate or log the error, or add a comment explaining why it is safe to ignore.",
  "when": ["let\\s+_\\s*=|\\.ok\\(\\);"]
}
```
Skip if: `clippy::let_underscore_must_use` is denied.

```json
{
  "id": "rs-map-err-drops-source",
  "question": "Does `added_code` use `.map_err(|_| ...)` to replace an error with a new error in internal library or service code, throwing away the original error without logging it or keeping it as a source?",
  "true": "`map_err(|_| ...)` discards the underlying error, losing the cause.",
  "false": "The original error is kept (`map_err(|e| MyError::Io(e))`, `#[from]`/`#[source]`, `.context(...)`), logged before replacing, or mapped into an HTTP status or user-facing validation message at an API boundary; or it converts an error that carries no information (e.g. `()` or a poisoned-lock error).",
  "fix": "Keep the original error as the source (`map_err(|e| ...)`, #[from], or .context()).",
  "when": ["map_err"]
}
```
Skip if: none. clippy has no lint for this.

```json
{
  "id": "rs-http-client-per-call",
  "question": "Does `added_code` build a new `reqwest::Client` (`Client::new()` or `Client::builder()...build()`) inside a loop or inside a function that sends a single request, instead of creating one client and reusing it?",
  "true": "A new HTTP client (and its connection pool) is created for each request or iteration.",
  "false": "One client is created at startup or outside the loop and passed in, cloned (cheap, shared pool), or stored in app state; or the code creates no reqwest client.",
  "fix": "Create one reqwest::Client and reuse it (it is cheap to clone).",
  "when": ["Client::(new|builder)"]
}
```
Skip if: the crate is a one-shot CLI that makes a single request per process.
