# Go candidates

These rules target concurrency lifetimes, context handling and error design, which
`go vet`, staticcheck and most golangci-lint linters cannot judge from intent. Leave out
anything a configured linter already enforces. errcheck covers unchecked errors, bodyclose
covers unclosed response bodies, govet copylocks covers copied mutexes, and errorlint
covers `err == ErrX` comparisons. Go 1.22 fixed loop-variable capture. Validate each
candidate on labeled cases before enabling it.

```json
{
  "id": "go-goroutine-no-lifecycle",
  "question": "Does `added_code` start a goroutine (`go func() { ... }()` or `go worker(...)`) that has no way to be stopped or waited for — no `sync.WaitGroup`, `errgroup.Group`, done/quit channel, or `ctx.Done()` check — especially one that runs a `for` loop forever?",
  "true": "A goroutine is launched with nothing that waits for it or can tell it to stop, so it can leak or outlive its caller.",
  "false": "The goroutine is tracked by a WaitGroup or errgroup, selects on `ctx.Done()` or a done channel, sends its result on a channel the caller always reads, or the code starts no goroutine.",
  "fix": "Give the goroutine a lifetime: pass a context and select on ctx.Done(), or track it with a WaitGroup/errgroup.",
  "when": ["\\bgo\\s+(func\\b|[A-Za-z_][\\w.]*\\()"]
}
```
Skip if: the snippet is `main()` wiring for a process-lifetime background worker that the team deliberately lets run until exit.

```json
{
  "id": "go-context-background-in-request",
  "question": "Does `added_code` call `context.Background()` or `context.TODO()` inside a function that already receives a `ctx context.Context` parameter or an `*http.Request` (whose context is `r.Context()`), instead of passing that incoming context along?",
  "true": "A request-scoped function drops its incoming context and starts a fresh one, so cancellation and deadlines are lost.",
  "false": "The function passes on `ctx` or `r.Context()` (possibly wrapped with `WithTimeout`/`WithCancel`), or it deliberately detaches with `context.WithoutCancel(ctx)` or a comment explaining why the work must outlive the request, or it has no incoming context (e.g. `main`, `init`, tests).",
  "fix": "Pass the incoming ctx (or r.Context()) instead of context.Background().",
  "when": ["context\\.(Background|TODO)\\(\\)"]
}
```
Skip if: golangci-lint `contextcheck` is enabled and trusted.

```json
{
  "id": "go-errorf-without-w",
  "question": "Does `added_code` wrap an error with `fmt.Errorf` using `%v` or `%s` for the error value (e.g. `fmt.Errorf(\"load config: %v\", err)`) instead of `%w`, so callers can no longer use `errors.Is` / `errors.As` on the cause?",
  "true": "An error is formatted into a new error with %v/%s and the wrapping chain is lost.",
  "false": "Errors are wrapped with `%w`, returned as-is, or wrapped with a helper that keeps the chain; or the code deliberately hides the cause at an API boundary and says so in a comment; or `fmt.Errorf` is not given an error value.",
  "fix": "Use %w when wrapping an error with fmt.Errorf.",
  "when": ["Errorf"]
}
```
Skip if: golangci-lint `errorlint` (errorf check) is enabled, since it enforces this deterministically.

```json
{
  "id": "go-http-no-timeout",
  "question": "Does `added_code` make an outbound HTTP call with no timeout — using `http.Get`/`http.Post`/`http.DefaultClient`, or a new `&http.Client{}` with no `Timeout` field — and without a request context that has a deadline (`http.NewRequestWithContext` with a `context.WithTimeout` ctx)?",
  "true": "An outbound HTTP request can hang forever because neither the client nor the request has a timeout.",
  "false": "The client sets `Timeout`, the request carries a context with a deadline or the caller's request context, or a shared, configured client is used; or the code makes no outbound HTTP call.",
  "fix": "Use an http.Client with a Timeout, or send the request with a context that has a deadline.",
  "when": ["http\\.(Get|Post|Head|PostForm|DefaultClient|Client\\b)|NewRequest"]
}
```
Skip if: all outbound HTTP goes through a shared, pre-configured client package.

```json
{
  "id": "go-goroutine-send-leak",
  "question": "Does `added_code` start a goroutine that sends its result on an unbuffered channel, while the receiving side can return early — a `select` with `time.After`, `ctx.Done()`, or an error branch — so the goroutine blocks forever on the send when nobody receives?",
  "true": "A goroutine sends on an unbuffered channel that the caller may abandon, leaking the goroutine.",
  "false": "The channel is buffered with room for every send (`make(chan T, 1)`), the sender itself selects on `ctx.Done()`, or the receiver always reads the value; or no goroutine sends on a channel.",
  "fix": "Make the channel buffered (`make(chan T, 1)`) or have the sender select on ctx.Done().",
  "when": ["chan\\b|<-"]
}
```
Skip if: the repo runs goleak in its tests and those tests cover this code path.

```json
{
  "id": "go-unsynchronized-shared-write",
  "question": "Does `added_code` start goroutines that write to a map, slice, counter, or other variable declared outside the goroutine (e.g. `results[id] = v` or `total += n` inside `go func() { ... }()`), with no `sync.Mutex`, `sync.Map`, atomic operation, or channel protecting the write?",
  "true": "Several goroutines may write the same outer variable concurrently, which is a data race.",
  "false": "Writes are guarded by a mutex, go through `sync.Map` or `atomic`, results are sent over a channel, or each goroutine writes only its own pre-sized slice index (`results[i] = v`); or no goroutine writes outer state.",
  "fix": "Guard the shared write with a mutex or send results over a channel.",
  "when": ["\\bgo\\s+(func\\b|[A-Za-z_][\\w.]*\\()"]
}
```
Skip if: CI runs `go test -race` on tests that exercise this code.

```json
{
  "id": "go-panic-for-errors",
  "question": "Does `added_code` call `panic(...)` or `log.Fatal*` for an ordinary, expected failure — invalid input, a missing record, a failed I/O or network call, or a returned `err` — in library or handler code, instead of returning an error?",
  "true": "A recoverable error is turned into a panic or a process exit outside of `main`.",
  "false": "Errors are returned to the caller; or the panic is in a `Must...` helper, in `main`/`init` during startup, in a test, or marks a truly impossible state (an unreachable switch default, a programmer bug).",
  "fix": "Return the error to the caller instead of panicking.",
  "when": ["panic\\(|log\\.Fatal"]
}
```
Skip if: the snippet is a `main` package or startup code where exiting on error is the team's convention.

```json
{
  "id": "go-sleep-for-sync",
  "question": "Does `added_code` use `time.Sleep` to wait for goroutines or asynchronous work to finish, or to 'let things settle' before reading a result, instead of a `sync.WaitGroup`, a channel, or a condition it polls?",
  "true": "`time.Sleep` stands in for real synchronization, so the code is racy and slow.",
  "false": "Completion is awaited with a WaitGroup, errgroup, channel receive, or `select`; or `time.Sleep` is used for deliberate pacing (rate limits, backoff between retries, a polling interval); or there is no `time.Sleep`.",
  "fix": "Wait on a WaitGroup or channel instead of sleeping.",
  "when": ["time\\.Sleep"]
}
```
Skip if: none. No standard linter checks this.

```json
{
  "id": "go-test-cannot-fail",
  "question": "Does `added_code` add a test (`func TestXxx(t *testing.T)` functions) that could not fail if the code it is named after were broken, because it (a) has no assertion at all (`t.Error`/`t.Fatal`/`t.Errorf`, testify `assert`/`require`, or `cmp.Diff` checks), (b) only asserts a tautology or a value the test itself just created (`if got := 1; got != 1`, `assert.Equal(t, x, x)`, `assert.NotNil(t, &Foo{})`), (c) only checks that a mock returns what the test configured (a fake that returns what the test configured, then asserting that value unchanged), or (d) mocks the very unit it claims to test (replacing the function under test with a stub variable)?",
  "true": "At least one added test has no assertion that depends on the real behaviour of the code under test: no assertion, a tautology, an assertion on the test's own stub or input, or the unit under test is itself mocked.",
  "false": "Every added test calls real code and asserts on its output, error, returned value or a side effect it causes (including calls the unit makes to a mock, with arguments the unit computed). Weak but real assertions do not count. Fixtures, factories, helpers and setup code without tests do not count, and neither does code that is not a test.",
  "fix": "Make the test exercise the real code and assert on a result that would change if that code broke; delete it if it can't.",
  "when": [
    "func Test\\w*\\("
  ]
}
```
Propose by default whenever the repo has tests. It mirrors the validated built-in `ts-test-cannot-fail` / `swift-test-cannot-fail` (holdout 12/12, no false alarms, 2026-09-27). Skip if: never, but still validate it on the repo's own test style.
