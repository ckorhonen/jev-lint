# Ruby candidates

These rules target data-access and side-effect patterns in Ruby and Rails that rubocop
and rubocop-rails cannot judge from syntax alone. rubocop already covers `rescue
Exception` (Lint/RescueException), `.all.each` (Rails/FindEach), `update_column` and other
calls that skip validations (Rails/SkipsModelValidations), and `Time.now` (Rails/TimeZone).
Brakeman covers most injection patterns if it runs in CI. Validate each candidate on
labeled cases before enabling it.

```json
{
  "id": "rb-n-plus-one",
  "question": "Does `added_code` loop over ActiveRecord records (`.each`, `.map`, `.find_each`, or a view `each` block) and, inside the loop, read an association or run a query per record — `post.author.name`, `order.line_items.sum(...)`, `user.comments.count`, `Model.find(...)`, `where(...)` — without `includes`, `preload`, `eager_load`, or a single bulk query before the loop?",
  "true": "Each loop iteration triggers another database query (N+1).",
  "false": "Associations are loaded up front with `includes`/`preload`/`eager_load`, counts use `counter_cache` or a grouped query, the loop only reads the record's own columns, or the loop is not over database records.",
  "fix": "Preload associations with includes/preload before the loop, or replace per-record queries with one grouped query.",
  "when": ["\\.each|\\.map|find_each|\\.collect|\\.select\\s*\\{|each_with"]
}
```
Skip if: the Bullet gem raises on N+1 in the test suite and the tests cover this code.

```json
{
  "id": "rb-rescue-swallowed",
  "question": "Does `added_code` have a `rescue` (bare `rescue`, `rescue => e`, or `rescue StandardError`) whose body is empty, only a comment, only `nil`, or only returns a default value, without logging the error, reporting it (e.g. `Rails.logger.error`, `Sentry.capture_exception`, `Honeybadger.notify`), or re-raising?",
  "true": "A broad rescue silently hides the failure.",
  "false": "The rescue logs, reports, or re-raises the error, or rescues a specific class (`ActiveRecord::RecordNotFound`, `JSON::ParserError`, `Timeout::Error`) with deliberate handling; or there is no rescue.",
  "fix": "Rescue the specific error you expect, or log/report it before continuing.",
  "when": ["rescue"]
}
```
Skip if: rubocop Lint/SuppressedException is set to `AllowComments: false` and `AllowNil: false`, which covers most of this.

```json
{
  "id": "rb-sql-interpolation",
  "question": "Does `added_code` interpolate a variable with `#{...}` into SQL passed to `where`, `order`, `joins`, `select`, `having`, `find_by_sql`, `exec_query`, or `execute`, instead of using placeholders (`where(\"name = ?\", name)`, `where(name: name)`) or `sanitize_sql`?",
  "true": "A runtime value is interpolated into a SQL fragment.",
  "false": "Values go through hash conditions, `?` or named placeholders, `sanitize_sql_*`, or Arel; or only a constant or an allow-listed column name is interpolated; or no SQL string is built.",
  "fix": "Use hash conditions or `?` placeholders instead of string interpolation in SQL.",
  "when": ["#\\{"]
}
```
Skip if: brakeman runs in CI and fails on SQL injection warnings. Prefer this over `gen-sql-string-building`, not both.

```json
{
  "id": "rb-job-in-save-callback",
  "question": "Does `added_code` enqueue a background job, send an email, or call an external service from an ActiveRecord `after_save`, `after_create`, `after_update`, or `after_destroy` callback instead of `after_commit` (or `after_create_commit` / `after_update_commit`)?",
  "true": "A side effect runs inside the transaction, so a job can run before the data is committed, or fire even though the transaction rolls back.",
  "false": "The side effect is in `after_commit`/`after_*_commit`, or in a service object after the save succeeds; or the callback only changes the record's own in-memory attributes; or no such callback is added.",
  "fix": "Move the side effect to after_commit (after_create_commit / after_update_commit).",
  "when": ["after_(save|create|update|destroy)"]
}
```
Skip if: the app uses a transactional outbox or its job adapter already enqueues after commit (for example, Rails 7.2+ `enqueue_after_transaction_commit`) and email is not a concern.

```json
{
  "id": "rb-side-effect-in-transaction",
  "question": "Does `added_code` make an HTTP request, send an email (`deliver_now`), charge a payment, or publish to an external queue inside an `ActiveRecord::Base.transaction do ... end` (or `Model.transaction`) block?",
  "true": "An external side effect happens inside a DB transaction, where it can't be rolled back and it holds the transaction open.",
  "false": "External calls happen before or after the transaction block, or jobs are enqueued after commit; or the transaction contains only database writes.",
  "fix": "Move external calls outside the transaction, or enqueue them to run after commit.",
  "when": ["transaction"]
}
```
Skip if: none. rubocop has no equivalent check.

```json
{
  "id": "rb-sidekiq-complex-args",
  "question": "Does `added_code` call a Sidekiq worker's `perform_async` or `perform_in` with an ActiveRecord object, a Symbol, a Time, or another non-JSON-native object (e.g. `SyncWorker.perform_async(user)`), instead of simple values like ids and strings?",
  "true": "A Sidekiq job receives a complex Ruby object that will not serialize cleanly or will be stale when the job runs.",
  "false": "Arguments are ids, strings, numbers, booleans, or plain hashes/arrays of them; or the job is ActiveJob `perform_later`, which serializes records via GlobalID; or no Sidekiq job is enqueued.",
  "fix": "Pass the record id (and other plain values) and load the record inside the job.",
  "when": ["perform_async|perform_in|perform_at"]
}
```
Skip if: the repo does not use Sidekiq, or enables Sidekiq strict args (`Sidekiq.strict_args!`) and tests enqueue this job.

```json
{
  "id": "rb-dynamic-dispatch-from-input",
  "question": "Does `added_code` pass request params or other user input to `send`, `public_send`, `constantize`, `safe_constantize`, `const_get`, `instance_variable_get`, or `eval`, without first checking the value against a fixed allow-list?",
  "true": "User input decides which method, class, or code runs.",
  "false": "The value is checked against an explicit allow-list or mapped through a hash of permitted options before the dynamic call; or the dynamic call uses only constant or internal values.",
  "fix": "Map input through an explicit allow-list (a hash of permitted values) before calling it dynamically.",
  "when": ["send\\(|constantize|const_get|instance_variable_get|eval"]
}
```
Skip if: brakeman runs in CI and flags UnsafeReflection and dangerous send.

```json
{
  "id": "rb-memoize-nil-or-false",
  "question": "Does `added_code` memoize with `@var ||= ...` where the value can legitimately be `nil` or `false` — for example `find_by`, `exists?`, `any?`, `present?`, a predicate method, or an API call that may return nil — so the expensive work reruns on every call?",
  "true": "`||=` memoizes a result that can be nil/false, so memoization silently does nothing in that case.",
  "false": "The memoized value is never nil/false (a relation, a `find` that raises, a new object, a collection), or the code uses `return @var if defined?(@var)` or a `key?` check; or no `||=` memoization is used.",
  "fix": "Use `return @x if defined?(@x); @x = ...` when the value can be nil or false.",
  "when": ["\\|\\|="]
}
```
Skip if: none. rubocop only checks memoized variable naming.
