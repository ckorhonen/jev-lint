# Python candidates

These rules target mistakes that ruff, mypy and pyright cannot see well: blocking work
inside `async def`, silent error handling, ORM query patterns and validation that gets
skipped. Mechanical checks are left out on purpose. Ruff already covers mutable defaults
(B006), `requests` without `timeout` (S113), dangling `create_task` (RUF006), missing
`raise ... from` (B904), `shell=True` (S602), naive datetimes (DTZ) and `open()` without
`with` (SIM115). Propose a candidate only if the repo uses the libraries it names, and
validate it against labeled cases before enabling it.

```json
{
  "id": "py-blocking-call-in-async",
  "question": "Does `added_code` call a blocking function directly inside an `async def` — `time.sleep`, `requests.*`, `urllib.request`, a synchronous DB driver (`psycopg2`, `sqlite3`, `pymysql`), `boto3`, `subprocess.run`, or a synchronous SDK client — instead of an async equivalent or `await asyncio.to_thread(...)` / `run_in_executor`?",
  "true": "An `async def` body makes a blocking call that stalls the event loop.",
  "false": "Blocking work goes through `asyncio.to_thread`, `run_in_executor`, or an async library (`httpx.AsyncClient`, `aiohttp`, `asyncpg`, `aioboto3`, `asyncio.sleep`), or the blocking call is in an ordinary `def`. Quick in-memory work and logging do not count.",
  "fix": "Use the async library or wrap the blocking call in `await asyncio.to_thread(...)`.",
  "when": ["async\\s+def"]
}
```
Skip if: ruff's flake8-async rules (ASYNC210/ASYNC220/ASYNC230/ASYNC251) are enabled and the repo uses no synchronous DB drivers or SDK clients, because ruff then covers the literal cases. Also skip if the repo has no asyncio code.

```json
{
  "id": "py-broad-except-silent",
  "question": "Does `added_code` catch `Exception`, `BaseException`, or use a bare `except:` and then carry on — `pass`, `continue`, `return None`, return a default value, or a comment only — without logging the exception or re-raising it?",
  "true": "A broad except block hides the failure: nothing is logged or re-raised.",
  "false": "The block logs the error (`logger.exception`, `log.warning(..., exc_info=True)`, `sentry_sdk.capture_exception`), re-raises it, or wraps and raises a new error; or it catches a specific exception type such as `KeyError`, `ValueError`, or `FileNotFoundError`; or there is no broad except at all.",
  "fix": "Catch the specific exception you expect, or log it with `logger.exception` before continuing.",
  "when": ["except"]
}
```
Skip if: ruff BLE001 and S110/S112 are enforced as errors. They already flag broad excepts that neither log nor re-raise.

```json
{
  "id": "py-sql-string-formatting",
  "question": "Does `added_code` build a SQL statement with an f-string, `%` formatting, `.format()`, or `+` concatenation that inserts a variable value, and pass it to `execute`, `executemany`, `raw`, `text(...)`, or `read_sql`, instead of using bound parameters?",
  "true": "A variable value is interpolated into SQL text that is then executed.",
  "false": "Values are passed as parameters (`cursor.execute(sql, (x,))`, `%s`/`?`/`:name` placeholders, `text(...).bindparams`) or the query is built with the ORM or query builder. Interpolating only a constant, or an identifier checked against a fixed allow-list, does not count.",
  "fix": "Pass values as bound query parameters instead of formatting them into the SQL string.",
  "when": ["select|insert|update|delete|execute|\\.raw\\(|text\\(|read_sql"]
}
```
Skip if: ruff S608 or bandit B608 already runs in CI and its false positives are acceptable to the team. Prefer this over `gen-sql-string-building`, not both.

```json
{
  "id": "py-sequential-await-loop",
  "question": "Does `added_code` `await` independent coroutines one at a time inside a `for` loop (for example `for uid in ids: users.append(await fetch_user(uid))`) when the calls do not depend on each other and could run concurrently with `asyncio.gather`, `asyncio.TaskGroup`, or a semaphore-bounded pool?",
  "true": "A loop awaits unrelated I/O calls one after another for no stated reason.",
  "false": "Calls run concurrently, each call needs the previous result (pagination cursors, retries, backoff), the loop uses one DB session or connection that cannot be shared concurrently, or a comment says sequencing or rate-limiting is intentional.",
  "fix": "Run independent calls with `asyncio.gather` or a `TaskGroup` (bounded with a semaphore if needed).",
  "when": ["await"]
}
```
Skip if: the repo has no asyncio code. Prefer this over `gen-sequential-independent-awaits`.

```json
{
  "id": "py-pydantic-construct-bypass",
  "question": "Does `added_code` create a pydantic model with `Model.model_construct(...)` or `Model.construct(...)` from data that came from outside the program — a request body, `json.loads`, `response.json()`, a file, a queue message, or `**data` from any of these — which skips all validation?",
  "true": "External data is turned into a model with `model_construct`/`construct`, so its fields are never validated.",
  "false": "The model is built with `Model(...)`, `Model.model_validate(...)`, or `model_validate_json(...)`; or `model_construct` is used only on data the code itself just built or already validated, such as values read back from its own database.",
  "fix": "Use `Model.model_validate(data)` for anything that came from outside the program.",
  "when": ["construct\\("]
}
```
Skip if: the repo does not use pydantic.

```json
{
  "id": "py-assert-for-validation",
  "question": "Does `added_code` use an `assert` statement in application code (not a test) to check user input, request data, permissions, authentication, or data from a file or network, where the check must also hold in production?",
  "true": "`assert` guards input, access, or external data in non-test code. Asserts are removed under `python -O`, so the check can silently vanish.",
  "false": "Input and permission checks use `if ...: raise ...` or a validation library; or `assert` appears only in tests, or checks an internal invariant or narrows a type for the type checker (`assert x is not None` after code that sets x).",
  "fix": "Replace the assert with an explicit `if ...: raise ValueError/PermissionError(...)`.",
  "when": ["\\bassert\\b"]
}
```
Skip if: ruff S101 is enforced for non-test code, which bans every assert.

```json
{
  "id": "py-orm-query-in-loop",
  "question": "Does `added_code` loop over ORM records (a Django QuerySet or SQLAlchemy query result) and, inside the loop, touch a related object or run another query per record — for example `order.customer.name`, `post.comments.all()`, `Model.objects.get(...)`, or `session.query(...)` — without `select_related`, `prefetch_related`, `joinedload`, `selectinload`, or a single bulk query before the loop?",
  "true": "Each iteration triggers another database query (an N+1 pattern).",
  "false": "Related data is loaded up front (`select_related`, `prefetch_related`, `joinedload`, `selectinload`, `.in_()`/`__in` bulk fetch), the loop only reads plain columns of each record, or the loop is not over database records.",
  "fix": "Load related data before the loop with select_related/prefetch_related (Django) or joinedload/selectinload (SQLAlchemy).",
  "when": ["\\bfor\\b"]
}
```
Skip if: the repo uses no ORM, or runs nplusone/django-zen-queries in tests that already fail on N+1 queries.

```json
{
  "id": "py-http-client-per-iteration",
  "question": "Does `added_code` create a new HTTP client or session — `requests.Session()`, `httpx.Client()`, `httpx.AsyncClient()`, or `aiohttp.ClientSession()` — inside a loop, making one or a few requests per iteration, instead of creating it once and reusing it?",
  "true": "A new client or session is opened on every loop iteration, throwing away connection pooling.",
  "false": "The client is created once, outside the loop (or passed in, or held by the app), and reused for every request; or the code uses the module-level `requests.get` helpers; or no client is created inside a loop.",
  "fix": "Create the client once outside the loop (`with httpx.Client() as client:`) and reuse it.",
  "when": ["Session\\(|Client\\(|AsyncClient\\("]
}
```
Skip if: the repo makes few outbound HTTP calls, or wraps HTTP access in its own shared client module.
