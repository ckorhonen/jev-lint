# Generic candidates

These patterns apply in most languages. Propose them for languages that have no file
here, or for a mixed repo. If a language file has a more specific version of a rule
(for example, `py-sql-string-formatting` or `rb-rescue-swallowed`), propose that
version instead of the generic one, not both. When one of these rules is used for a
single language, name that language's APIs in `question` and `when`. Jev answers the
literal words, so concrete API names improve precision. Validate each candidate on
labeled cases before enabling it.

```json
{
  "id": "gen-unvalidated-request-input",
  "question": "Does `added_code` read fields from an incoming HTTP request or webhook — body, query string, path params, form data, or headers (e.g. `req.body.x`, `request.json[\"x\"]`, `params[:x]`, `r.FormValue(\"x\")`) — and pass them straight into a database write, a model create/update, an outbound API call, or an authorization decision, with no validation, schema parsing, type conversion, or allow-list?",
  "true": "Raw request data flows into a write, outbound call, or access check without being validated.",
  "false": "The input goes through a validator or schema (zod, pydantic, DRF serializer, Rails strong params plus model validations, a form object, JSON-schema, struct binding with validation tags), is converted and range-checked, or is checked against an allow-list; or the handler receives already-typed, validated parameters from the framework; or no request data is used.",
  "fix": "Validate request data with a schema or explicit checks before using it.",
  "when": ["req|request|params|body|query|form|header|webhook|payload"]
}
```
Skip if: the repo's framework validates every handler input by construction (typed, validated route parameters). The language packs' `ts-unvalidated-external-data` already covers parsed JSON in TypeScript.

```json
{
  "id": "gen-sql-string-building",
  "question": "Does `added_code` build a SQL statement by concatenating or interpolating a variable value into the query text (string `+`, template or f-strings, `format`, `sprintf`/`Sprintf`, `#{}`) and then execute it, instead of using bound parameters or a query builder?",
  "true": "A runtime value is spliced into SQL text that is executed.",
  "false": "Values are passed as bound parameters (`?`, `$1`, `:name`, `%s` with a params argument), or the query is built with an ORM or query builder; or only constants or identifiers checked against an allow-list are inserted; or no SQL is built.",
  "fix": "Pass values as bound query parameters instead of building SQL strings.",
  "when": ["select|insert|update|delete|query|execute|exec\\("]
}
```
Skip if: gosec G201/G202, bandit/ruff S608, brakeman, or Semgrep SQL-injection rules already gate CI.

```json
{
  "id": "gen-shell-command-string",
  "question": "Does `added_code` run a shell command whose text is built from a variable — `os.system(...)`, `subprocess` with `shell=True`, `child_process.exec(...)`, `exec.Command(\"sh\", \"-c\", ...)`, backticks or `system(...)` in Ruby, `Runtime.exec(String)` — instead of passing arguments as a separate list with no shell?",
  "true": "A variable is interpolated into a shell command string, allowing injection.",
  "false": "Arguments are passed as an array to a no-shell API (`subprocess.run([...])`, `execFile`, `exec.Command(bin, args...)`, `system(\"cmd\", arg)`), or they are escaped with a proper quoting function (`shlex.quote`), or the command is a constant; or no shell command is run.",
  "fix": "Pass arguments as a list to a no-shell process API instead of building a command string.",
  "when": ["system|exec|spawn|popen|shell|Command\\(|`"]
}
```
Skip if: bandit/ruff S602–S605, gosec G204, or brakeman command-injection checks gate CI.

```json
{
  "id": "gen-path-from-input",
  "question": "Does `added_code` build a filesystem path from request or user input (a filename, id, or path segment from a request, upload, archive entry, or CLI/API argument) and then read, write, serve, or delete that file without normalizing the path and checking it stays inside the intended base directory?",
  "true": "External input chooses a file path with no traversal check, so `../` can escape the directory.",
  "false": "The path is resolved and verified to be under the base directory (`realpath`/`resolve` + prefix check, `filepath.IsLocal`, `os.Root`, `safe_join`, `send_from_directory`), the name is replaced by a generated id, or it is checked against an allow-list; or the path does not come from external input.",
  "fix": "Resolve the path and verify it stays inside the base directory (or use a generated file name).",
  "when": ["path|file|open|join|upload|download|send_file|sendFile|readFile|writeFile"]
}
```
Skip if: gosec G304 or an equivalent path-traversal check already gates CI and the team accepts its noise.

```json
{
  "id": "gen-swallowed-error-comment-only",
  "question": "Does `added_code` catch or check an error and then do nothing — a `catch`/`except`/`rescue` block, or an `if err != nil` branch, whose body is empty, only a comment (e.g. `// ignore`, `# TODO handle`), only `pass`, or only `continue` — without logging, returning, or re-raising the error?",
  "true": "An error is caught and silently discarded, at most with a comment.",
  "false": "The error is logged, returned, re-thrown, wrapped, reported, or turned into a user-visible result; or the comment names a specific expected condition and the caught type is that specific error (e.g. file-not-found during best-effort cleanup); or there is no error handling.",
  "fix": "Log, return, or re-raise the error, or catch only the specific expected error and say why it's safe.",
  "when": ["catch|except|rescue|err\\s*!=\\s*nil|pcall|Err\\("]
}
```
Skip if: the language linter already bans empty handlers including comment-only ones (ruff S110/S112, rubocop Lint/SuppressedException with `AllowComments: false`, ESLint `no-empty` with `allowEmptyCatch: false`).

```json
{
  "id": "gen-sequential-independent-awaits",
  "question": "Does `added_code` perform two or more independent asynchronous calls or network requests one after another (e.g. `user = await getUser(id); orders = await getOrders(id)`), where no later call uses the result of an earlier one and they could run concurrently (`Promise.all`, `asyncio.gather`, `async let`, `errgroup`, `join!`, `awaitAll`)?",
  "true": "Independent requests are awaited back to back, adding their latencies together.",
  "false": "Each call uses a previous result, the calls already run concurrently, they share a connection or transaction that cannot be used concurrently (one DB session, one SQL transaction), order matters for side effects, or a comment says sequencing or rate-limiting is intentional; or there is only one async call.",
  "fix": "Start the independent calls together and await them jointly (Promise.all / gather / async let / errgroup).",
  "when": ["await|async|\\.then\\(|Future|go\\s+func"]
}
```
Skip if: the language pack already has a loop-specific variant enabled (`ts-sequential-await-loop`, `py-sequential-await-loop`) and the team only cares about loops.

```json
{
  "id": "gen-boolean-flag-params",
  "question": "Does `added_code` define or call a function with two or more positional boolean parameters, so call sites read like `render(item, true, false)` and the meaning of each flag is unclear?",
  "true": "A function takes or is called with several bare positional boolean flags.",
  "false": "Flags are passed by name (keyword or named arguments such as `send(notify=True)` or `send(notify: true)`, or an options object/struct), replaced by enums, or split into separate functions; or the function takes at most one boolean.",
  "fix": "Use named arguments, an options object, or an enum instead of positional booleans.",
  "when": ["\\btrue\\b|\\bfalse\\b|\\bbool"]
}
```
Skip if: the language forces argument labels at call sites (Swift), or the TypeScript pack's `ts-boolean-trap` already covers the files.

```json
{
  "id": "gen-hardcoded-secret",
  "question": "Does `added_code` contain a literal credential — an API key, access token, password, client secret, private key, webhook signing secret, or a connection string with an embedded password — written directly in source code rather than read from environment variables, a secrets manager, or config excluded from the repo?",
  "true": "A real-looking secret value is hardcoded in the code.",
  "false": "Secrets are read from env vars, a secret store, or injected config; or the value is an obvious placeholder (`\"changeme\"`, `\"<your-key>\"`, `\"test\"`, `xxx`), a public identifier (a publishable key or client id meant to be public), a test fixture clearly marked as fake, or the name of an env var; or there is no credential.",
  "fix": "Move the secret to an environment variable or secret store and rotate the exposed value.",
  "when": ["key|token|secret|passw|pwd|credential|auth|bearer|private|://[^\\s/]*:[^\\s/]*@|sk_|ghp_|AKIA"]
}
```
Skip if: gitleaks, trufflehog, or GitHub push protection already gates commits. They are deterministic and more reliable for known key formats.

```json
{
  "id": "gen-retry-without-backoff",
  "question": "Does `added_code` retry a failing operation in a loop (`while True`/`for {}`/`loop` with try-again logic, or a retry counter) with no delay between attempts, or with no maximum number of attempts or deadline?",
  "true": "A retry loop hammers the target with no backoff, or can retry forever.",
  "false": "Retries wait with a delay or exponential backoff (ideally with jitter) and stop after a maximum number of attempts or a deadline, or use a retry library (tenacity, backoff, retry-go, p-retry, Polly); or the code does not retry.",
  "fix": "Add exponential backoff with jitter and a maximum attempt count or deadline.",
  "when": ["retry|retries|attempt|while|for\\s*\\{|loop\\s*\\{|backoff"]
}
```
Skip if: all outbound calls go through a shared client that already implements retries.

```json
{
  "id": "gen-log-sensitive-data",
  "question": "Does `added_code` log or print a password, token, API key, session cookie, `Authorization` header, full request or response headers, a full credit-card or government id number, or a whole user/request object that contains such fields?",
  "true": "Secrets or sensitive personal data are written to logs or stdout.",
  "false": "Logs contain only ids, counts, statuses, or explicitly redacted/masked values (`***`, last four digits), or use a logger with a redaction filter the code applies; or nothing sensitive is logged.",
  "fix": "Remove or redact the sensitive field before logging; log an id instead.",
  "when": ["log|print|console\\.|puts|debug|info|warn|error"]
}
```
Skip if: the repo's logging layer redacts known sensitive keys automatically and the snippet uses it.

```json
{
  "id": "gen-tls-verification-disabled",
  "question": "Does `added_code` disable TLS certificate or hostname verification — `verify=False`, `InsecureSkipVerify: true`, `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `CERT_NONE`, `VERIFY_NONE`, `danger_accept_invalid_certs(true)`, or a trust manager or `HostnameVerifier` that accepts everything?",
  "true": "TLS verification is turned off for a connection.",
  "false": "Verification stays on, possibly with a custom CA bundle or pinned certificate; or the disabling is confined to a test or local-development branch that a condition or comment makes explicit; or no TLS settings are changed.",
  "fix": "Keep verification on; trust a custom CA bundle instead of disabling checks.",
  "when": ["verify|InsecureSkipVerify|rejectUnauthorized|TLS_REJECT|CERT_NONE|VERIFY_NONE|invalid_certs|TrustManager|HostnameVerifier"]
}
```
Skip if: bandit/ruff S501, gosec G402, or Semgrep TLS rules already gate CI.

```json
{
  "id": "gen-placeholder-implementation",
  "question": "Does `added_code` add a function or branch whose real logic is replaced by a placeholder — returning a hardcoded or mock value, `pass`/`nil`/empty result, or throwing 'not implemented' — together with a comment such as `TODO`, `placeholder`, `stub`, `mock for now`, or `in a real implementation`, in non-test code?",
  "true": "Production code contains a stub or fake result in place of the real behavior.",
  "false": "The function is fully implemented; or the placeholder is in a test, fixture, mock, or an interface/abstract method that subclasses implement; or the TODO is only a follow-up note on code that already works.",
  "fix": "Implement the real logic, or fail loudly and tell the user what is still missing instead of returning fake data.",
  "when": ["todo|fixme|placeholder|stub|mock|not implemented|unimplemented|NotImplemented|real implementation|for now|hardcoded"]
}
```
Skip if: the repo deliberately scaffolds stubs (for example, generated API handlers that are filled in later).
