# Kotlin candidates

These rules target coroutine scoping, dispatcher misuse, cancellation and Android state
handling, which detekt and ktlint check poorly or not at all. Several detekt rules
overlap with them and are off by default. If the repo enables one, drop the matching
candidate. Compose Lint covers `mutableStateOf` without `remember`, so that is left out.
Validate each candidate on labeled cases before enabling it.

```json
{
  "id": "kt-unscoped-coroutine",
  "question": "Does `added_code` launch a coroutine on `GlobalScope` (`GlobalScope.launch` / `GlobalScope.async`) or on a new scope created inline and used immediately (`CoroutineScope(Dispatchers.IO).launch { ... }`), instead of a lifecycle-bound or injected scope that is cancelled?",
  "true": "A coroutine starts in a scope nobody cancels, so it can leak and outlive its owner.",
  "false": "Work runs in `viewModelScope`, `lifecycleScope`, a scope passed in or injected, a `coroutineScope { }` / `supervisorScope { }` block, or a scope stored in a property that is cancelled in a close/clear method; or no coroutine is launched.",
  "fix": "Launch in a lifecycle-bound or injected scope (viewModelScope, lifecycleScope, or an app scope you cancel).",
  "when": ["GlobalScope|CoroutineScope\\("]
}
```
Skip if: detekt `GlobalCoroutineUsage` is enabled and inline `CoroutineScope(...)` is not a concern in the repo.

```json
{
  "id": "kt-blocking-on-main",
  "question": "Does `added_code` do blocking work on the main thread — `Thread.sleep`, file or database I/O, OkHttp `execute()`, JDBC, `Future.get()`, or other synchronous network calls — inside `viewModelScope.launch`, `lifecycleScope.launch`, `Dispatchers.Main`, or a UI callback such as `onCreate` or `onClick`, without `withContext(Dispatchers.IO)` or `Dispatchers.Default`?",
  "true": "Blocking I/O or sleeping runs on the main/UI thread.",
  "false": "Blocking work is wrapped in `withContext(Dispatchers.IO)` or `Dispatchers.Default`; or the calls are main-safe suspend functions (Retrofit or Room `suspend` DAOs, Ktor client, `delay`); or the code is not on the main thread.",
  "fix": "Move blocking work into `withContext(Dispatchers.IO) { ... }` or call a main-safe suspend API.",
  "when": ["launch|Dispatchers\\.Main|onCreate|onClick|setOnClickListener|Thread\\.sleep"]
}
```
Skip if: the code is not Android or UI code. detekt `SleepInsteadOfDelay` covers only `Thread.sleep` inside suspend functions.

```json
{
  "id": "kt-runblocking-in-app-code",
  "question": "Does `added_code` call `runBlocking` inside a suspend function, a coroutine, an Android component (Activity, Fragment, ViewModel, Service), or a request handler, instead of calling the suspend function from a coroutine scope?",
  "true": "`runBlocking` blocks a thread that should be free, which can freeze the UI or deadlock a dispatcher.",
  "false": "`runBlocking` appears only in `main()`, tests, or a bridge from truly synchronous framework code that a comment explains; or suspend code is called from a proper scope; or `runBlocking` is not used.",
  "fix": "Call the suspend function from a coroutine scope (or make the caller suspend) instead of runBlocking.",
  "when": ["runBlocking"]
}
```
Skip if: the code is a CLI or script whose `main()` legitimately uses `runBlocking`.

```json
{
  "id": "kt-double-bang-external",
  "question": "Does `added_code` use the `!!` operator on a value that can really be null at runtime — a Java/platform API return, an Intent extra or Bundle argument, a map lookup (`map[key]!!`), a JSON or network field, `findViewById`, or `System.getenv` — instead of handling the null case?",
  "true": "`!!` asserts non-null on external or platform data, so a missing value crashes with a NullPointerException.",
  "false": "Nulls are handled with `?.`, `?:`, `requireNotNull(x) { \"message\" }`, `checkNotNull`, or an early return; or `!!` is on a value the same snippet just checked or assigned as non-null; or `!!` is not used.",
  "fix": "Handle the null with `?:`/`?.`, or use `requireNotNull(x) { \"why\" }` with a message.",
  "when": ["!!"]
}
```
Skip if: detekt `UnsafeCallOnNullableType` is enforced, which bans every `!!`.

```json
{
  "id": "kt-catch-swallows-cancellation",
  "question": "Does `added_code` catch `Exception` or `Throwable` (or use `runCatching`) around suspend calls inside a coroutine or suspend function, without rethrowing `CancellationException`, so cancelling the coroutine is swallowed and the work keeps going?",
  "true": "A broad catch or runCatching in suspend code can swallow CancellationException.",
  "false": "The code catches specific exceptions (`IOException`, `HttpException`), rethrows `CancellationException` first (`catch (e: CancellationException) { throw e }` or `if (e is CancellationException) throw e`), or calls `ensureActive()` after catching; or the catch is not around suspend calls.",
  "fix": "Catch specific exceptions, or rethrow CancellationException before handling the rest.",
  "when": ["catch|runCatching"]
}
```
Skip if: detekt `SuspendFunSwallowedCancellation` is enabled.

```json
{
  "id": "kt-exposed-mutable-state",
  "question": "Does `added_code` expose a `MutableStateFlow`, `MutableSharedFlow`, `MutableLiveData`, or `mutableStateOf` holder as a public (non-private) property of a ViewModel or state holder, so other classes can change its value directly?",
  "true": "A mutable state holder is public, so views can write to it and bypass the state owner.",
  "false": "The mutable holder is `private` (e.g. `_state`) and exposed as read-only `StateFlow`/`SharedFlow`/`LiveData` (`asStateFlow()`, `asSharedFlow()`) or `State<T>`, or with `private set`; or the class is not a state owner.",
  "fix": "Make the mutable holder private and expose a read-only StateFlow/LiveData.",
  "when": ["MutableStateFlow|MutableSharedFlow|MutableLiveData|mutableStateOf"]
}
```
Skip if: the repo is not Android/Compose code or has no ViewModel-style state holders.

```json
{
  "id": "kt-collect-without-lifecycle",
  "question": "Does `added_code` collect a Flow in an Activity or Fragment with `lifecycleScope.launch { flow.collect { ... } }` (or `launchWhenStarted`/`launchWhenResumed`) without `repeatOnLifecycle` or `flowWithLifecycle`, so collection keeps running while the UI is in the background?",
  "true": "A UI-layer flow collection is not tied to the STARTED/RESUMED lifecycle state.",
  "false": "Collection is wrapped in `repeatOnLifecycle(Lifecycle.State.STARTED)` or uses `flowWithLifecycle`, or happens in Compose via `collectAsStateWithLifecycle`; or the collection is not in an Activity or Fragment.",
  "fix": "Wrap the collect in `repeatOnLifecycle(Lifecycle.State.STARTED) { ... }`.",
  "when": ["collect|launchWhen"]
}
```
Skip if: the repo is not Android.

```json
{
  "id": "kt-state-mutated-in-place",
  "question": "Does `added_code` change a value held in `StateFlow`, `LiveData`, or Compose `mutableStateOf` in place — calling `add`/`remove`/`clear` on a `MutableList` inside it, or assigning a `var` property of the held object (e.g. `_state.value.items.add(x)` or `uiState.value.loading = true`) — instead of assigning a new value built with `copy()` or `update { }`?",
  "true": "State is mutated in place, so observers are not notified and the UI can miss the change.",
  "false": "Updates assign a new value (`_state.update { it.copy(...) }`, `_state.value = _state.value.copy(...)`, a new list with `+`), or state uses `mutableStateListOf`/`SnapshotStateList` whose mutations are observed; or no held state is mutated.",
  "fix": "Build a new value with copy()/update { } instead of mutating the held state.",
  "when": ["\\.value|StateFlow|LiveData|mutableStateOf|\\.update\\s*\\{"]
}
```
Skip if: the repo does not use StateFlow, LiveData or Compose state.

```json
{
  "id": "kt-compose-expensive-body",
  "question": "Does `added_code` do expensive work directly in a `@Composable` function body, without `remember` or `derivedStateOf` — creating a `SimpleDateFormat`/`DateTimeFormatter`/`Regex`, sorting or filtering a large list, parsing JSON, or reading files or preferences — so the work reruns on every recomposition?",
  "true": "Heavy work or object creation runs on every recomposition.",
  "false": "The work is wrapped in `remember(key) { ... }` or `derivedStateOf`, done in the ViewModel, or started in `LaunchedEffect`; or the composable only lays out UI.",
  "fix": "Wrap the work in remember(keys) { } or move it to the ViewModel.",
  "when": ["@Composable"]
}
```
Skip if: the repo does not use Jetpack Compose.

```json
{
  "id": "kt-test-cannot-fail",
  "question": "Does `added_code` add a test (JUnit `@Test` functions or Kotest specs) that could not fail if the code it is named after were broken, because it (a) has no assertion at all (`assertEquals`/`assertThat`/`shouldBe`/`assertThrows`), (b) only asserts a tautology or a value the test itself just created (`assertTrue(true)`, `x shouldBe x`), (c) only checks that a mock returns what the test configured (a MockK/Mockito stub `every { … } returns v` then asserting only `v`, or `verify` on a call the test itself made), or (d) mocks the very unit it claims to test (mocking the class under test (`mockk<Foo>()` when `Foo` is the subject))?",
  "true": "At least one added test has no assertion that depends on the real behaviour of the code under test: no assertion, a tautology, an assertion on the test's own stub or input, or the unit under test is itself mocked.",
  "false": "Every added test calls real code and asserts on its output, error, returned value or a side effect it causes (including calls the unit makes to a mock, with arguments the unit computed). Weak but real assertions do not count. Fixtures, factories, helpers and setup code without tests do not count, and neither does code that is not a test.",
  "fix": "Make the test exercise the real code and assert on a result that would change if that code broke; delete it if it can't.",
  "when": [
    "@Test|shouldBe|FunSpec|StringSpec|DescribeSpec"
  ]
}
```
Propose by default whenever the repo has tests. It mirrors the validated built-in `ts-test-cannot-fail` / `swift-test-cannot-fail` (holdout 12/12, no false alarms, 2026-09-27). Skip if: never, but still validate it on the repo's own test style.
