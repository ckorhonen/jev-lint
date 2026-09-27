# Practices pack

Opinionated framework and language practices: React and Server Actions, SwiftUI and Swift concurrency, Kotlin coroutines and Compose, Rust async, Python async and ORMs, Rails, Bazel, and common security mistakes. Each one needs judgment about what the code means, so no linter can check it.

Each rule shows code the check flags (**bad**), similar code it leaves alone (**good**), and why. The examples are real cases from the eval set. _Candidate_ rules are still being evaluated and are not asked by the hook yet.

## Bazel

### `bzl-public-visibility`

Does the new code set `default_visibility = ["//visibility:public"]` in `package(...)`, or give `visibility = ["//visibility:public"]` to a target that is an implementation detail -- a helper named `internal`, `impl`, `util`/`utils`, `private`, `testutil`/`testing`/`test_helpers`/`mocks`/`fixtures`, a `testonly = True` target, a generated intermediate (`genrule` output, `*_gen`), or a target created inside a macro?

**Catches:** A package default or an internal/helper target is made visible to the whole workspace.

**Why it matters:** (inferred, no study found): the shortest fix for a 'target is not visible' build error is `//visibility:public`.

**Fix:** Restrict visibility to the packages that need it (a `package_group` or `//pkg:__subpackages__`) instead of `//visibility:public` (Bazel BUILD style guide).

**Bad** (`BUILD`):

```starlark
java_library(
    name = "internal",
    srcs = glob(["*.java"]),
    visibility = ["//visibility:public"],
    deps = [
        "//java/com/acme/search/index",
        "@maven//:com_google_guava_guava",
    ],
)
```

**Good** (`BUILD`, looks similar but is fine):

```starlark
exports_files(
    ["tsconfig.base.json", ".eslintrc.json"],
    visibility = ["//visibility:public"],
)

alias(
    name = "prettier_config",
    actual = "//config/prettier:config",
    visibility = ["//visibility:public"],
)
```

**Not flagged:** Public visibility is on a target that is the package's intended public API (its main `*_library`, `*_binary`, `*_proto_library`, an `alias` or `exports_files` meant for consumers, a macro's main target forwarding its `visibility` argument); visibility is restricted (`//visibility:private`, `//pkg:__subpackages__`, a `package_group`, specific packages); or no public visibility is added.

Holdout: precision 100%, recall 100% (6 violations in the holdout set). Sources: [bazel.build](https://bazel.build/build/style-guide), [bazel.build](https://bazel.build/concepts/visibility)

### `bzl-nonhermetic-action`

Does the new code add a `genrule` `cmd` (or `cmd_bash`) or a `ctx.actions.run_shell` command that reaches outside its declared inputs -- downloading (`curl`, `wget`, `git clone`, `pip install`, `npm install`, `go get`, `apt-get`), calling tools by absolute host path (`/usr/bin/...`, `/usr/local/...`, `/opt/homebrew/...`), reading `$HOME`, `~` or absolute source-tree paths, writing into the source tree, or embedding the current time or randomness (`date`, `$RANDOM`, `uuidgen`) in outputs?

**Catches:** A build action depends on the host machine, the network, or the clock, so it is not hermetic or cacheable.

**Why it matters:** agents translate Makefile/shell habits (curl, /usr/bin/python3) into genrules.

**Fix:** Declare the tool as a `tools`/toolchain dependency and fetch external files with a repository rule (`http_file`/`http_archive`) instead of reaching outside the sandbox (Bazel 'Hermeticity').

**Bad** (`BUILD.bazel`):

```starlark
genrule(
    name = "geoip_db",
    outs = ["GeoLite2-City.mmdb"],
    cmd = "curl -sSL https://download.example.com/geoip/GeoLite2-City.mmdb -o $@",
)
```

**Good** (`BUILD.bazel`, looks similar but is fine):

```starlark
genrule(
    name = "version_header",
    outs = ["version.h"],
    cmd = "sed -n 's/^STABLE_GIT_COMMIT //p' bazel-out/stable-status.txt | awk '{print \"#define GIT_COMMIT \\\"\" $$1 \"\\\"\"}' > $@",
    stamp = 1,
)
```

**Not flagged:** Tools come from `tools`/`toolchains` via `$(location)`, `$(execpath)` or `ctx.executable`; inputs are declared `srcs`; downloads happen in a repository rule or module extension (`http_archive`, `http_file`, `repository_ctx.download`), where fetching is expected; stamping uses `stamp`/`--workspace_status_command`; or only standard POSIX utilities are called by name (`cp`, `cat`, `sed`, `tar`, `mkdir`).

Holdout: precision 100%, recall 100% (7 violations in the holdout set). Sources: [bazel.build](https://bazel.build/basics/hermeticity), [bazel.build](https://bazel.build/reference/be/general#genrule)

### `bzl-genrule-tool-in-srcs`

Does the new code add a `genrule` whose `cmd` executes a target -- via `$(location :x)`, `$(execpath :x)` or `$(rootpath :x)` in the command position, or `python3 $(location :script.py)` -- that is listed in `srcs` rather than `tools`, such as a `*_binary`, an `sh_binary`, or a `.sh`/`.py` script the command runs?

**Catches:** A program run by the genrule is declared in `srcs`, so it is built for the target platform instead of the exec platform.

**Why it matters:** passes local builds, so agents' tests never catch it.

**Fix:** Move the executed target from `srcs` to `tools` so it is built in the exec configuration (Bazel genrule docs).

**Bad** (`BUILD`):

```starlark
genrule(
    name = "calibration_table",
    srcs = [
        "gen_table.sh",
        "sensors.csv",
    ],
    outs = ["calibration_table.h"],
    cmd = "$(location gen_table.sh) $(location sensors.csv) > $@",
)
```

**Good** (`BUILD`, looks similar but is fine):

```starlark
genrule(
    name = "merged_messages",
    srcs = glob(["locales/*.json"]),
    outs = ["messages.json"],
    cmd = "cat $(SRCS) > $@",
)
```

**Not flagged:** Every executed program is in `tools` (or `toolchains`); entries in `srcs` are only read or passed as data arguments to a tool (`cat $(SRCS)`, `$(location :tool) $(location :input.json)`); or the command runs only standard shell utilities; or the target is not a genrule.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [bazel.build](https://bazel.build/reference/be/general#genrule)

### `bzl-sandbox-opt-out-unexplained`

Does the new code opt a target or action out of sandboxing, remote execution or caching -- tags `no-sandbox`, `no-remote`, `no-remote-exec`, `no-cache`, `local`, `requires-network`, `local = True` on a genrule, or `execution_requirements = {"no-sandbox": "1"}` -- with no comment explaining why?

**Catches:** A target escapes the sandbox or cache with no stated reason, usually to paper over an undeclared input or host dependency.

**Why it matters:** adding `no-sandbox` is the quickest way to make a 'file not found in sandbox' error disappear.

**Fix:** Declare the missing inputs or tools instead of disabling the sandbox, or add a comment with the reason.

**Bad** (`BUILD.bazel`):

```starlark
load("@rules_go//go:def.bzl", "go_test")

go_test(
    name = "checkout_flow_test",
    srcs = ["checkout_flow_test.go"],
    tags = ["no-sandbox"],
    deps = ["//services/checkout"],
)
```

**Good** (`BUILD.bazel`, looks similar but is fine):

```starlark
cc_binary(
    name = "matmul_bench",
    srcs = ["matmul_bench.cc"],
    tags = [
        "exclusive",
        "cpu:8",
    ],
    deps = ["@com_google_benchmark//:benchmark_main"],
)
```

**Not flagged:** A comment on or next to the tag says why (e.g. a tool that needs a license server, a test that talks to a real device); the tag only adds resources or scheduling (`exclusive`, `cpu:N`); or no such tag is added.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [bazel.build](https://bazel.build/basics/hermeticity), [bazel.build](https://bazel.build/reference/be/general#genrule)

### `bzl-macro-fixed-target-names` _(candidate)_

Does the new code define a Starlark macro (a function in a `.bzl` file that calls rules or `native.*` rules, or a `macro(implementation = ...)`) that creates a target whose `name` is a fixed string or not derived from the macro's `name` argument (e.g. `native.genrule(name = "gen_config", ...)` instead of `name = name + "_gen"`), so calling the macro twice in one package collides?

**Catches:** A macro creates targets with hard-coded names.

**Why it matters:** agents write macros that create a fixed helper target and test with one call site only.

**Fix:** Derive every generated target's name from the macro's `name` (e.g. `name + "_gen"`) (Bazel .bzl style guide, Macros).

**Bad** (`migrations.bzl`):

```starlark
def sql_migrations(name, srcs):
    native.filegroup(
        name = name,
        srcs = srcs,
    )
    native.sh_test(
        name = "migrations_lint_test",
        srcs = ["//tools/sql:lint.sh"],
        data = [":" + name],
    )
```

**Good** (`labels.bzl`, looks similar but is fine):

```starlark
def service_deps(service, extra = []):
    """Returns the standard dependency labels for a service package."""
    base = [
        "//libs/log",
        "//libs/metrics",
        "//services/%s/proto:%s_go_proto" % (service, service),
    ]
    return base + extra

def image_tag(version, env):
    return "%s-%s" % (version, env)
```

**Not flagged:** Every created target's name is `name` or starts with `name` plus a suffix (`name + "_lib"`, `"%s_gen" % name`, `"{}_test".format(name)`); or the function is a rule or aspect implementation (`def _impl(ctx)`) or a helper that creates no targets.

Holdout: precision 100%, recall 60% (5 violations in the holdout set). Sources: [bazel.build](https://bazel.build/rules/bzl-style), [bazel.build](https://bazel.build/extending/macros)

### `bzl-depset-flatten-in-impl`

Does the new code, in a rule or aspect implementation (`def _impl(ctx)`, `def _aspect_impl(target, ctx)`), call `.to_list()` on a transitive depset built from dependencies (`dep[MyInfo].transitive_srcs`, `depset(transitive = ...)`, `dep[DefaultInfo].files`) to loop over it, concatenate it, or turn files into path strings, instead of passing the depset to `ctx.actions.args()` (`args.add_all`) or an action's `inputs`?

**Catches:** A transitive depset is flattened in analysis, which is O(N^2) across the build graph.

**Why it matters:** Python-trained habits turn every collection into a list.

**Fix:** Pass the depset directly to `ctx.actions.args().add_all(...)` or to `inputs =` instead of calling `.to_list()` (Bazel 'Optimizing performance' for rules).

**Bad** (`bundle.bzl`):

```starlark
files = []
    for dep in ctx.attr.deps:
        files.extend(dep[DefaultInfo].files.to_list())
    ctx.actions.run(
        executable = ctx.executable._esbuild,
        arguments = ["--bundle", "--outfile=" + out.path] + [f.path for f in files],
        inputs = files,
        outputs = [out],
    )
```

**Good** (`sass_tests.bzl`, looks similar but is fine):

```starlark
load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load(":sass.bzl", "SassInfo")

def _transitive_srcs_test_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    names = [f.basename for f in target[SassInfo].transitive_srcs.to_list()]
    asserts.equals(env, ["_colors.scss", "_mixins.scss", "main.scss"], sorted(names))
    return analysistest.end(env)

transitive_srcs_test = analysistest.make(_transitive_srcs_test_impl)
```

**Not flagged:** Depsets are passed straight to `args.add_all(...)` (with `map_each`/`format_each` if needed), `inputs = depset(...)`, or `depset(transitive = [...])`; `.to_list()` is called only on a local, non-transitive depset, or in a test/debug rule on a single target; or the code is not a rule or aspect implementation.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [bazel.build](https://bazel.build/rules/performance)

## Kotlin

### `kt-unscoped-coroutine`

Does the new code launch a coroutine on a scope nobody cancels: `GlobalScope.launch`/`GlobalScope.async`, a scope created inline and used right away (`CoroutineScope(Dispatchers.IO).launch { … }`, `CoroutineScope(Job()).async { … }`, `MainScope().launch { … }`), or a new scope created inside a function on every call?

**Catches:** A coroutine starts in a scope with no owner, so it can leak, outlive its screen or request, and be impossible to cancel or test.

**Why it matters:** `CoroutineScope(Dispatchers.IO).launch` is the 'make the red squiggle go away' fix agents reach for when calling suspend code from a non-suspend context.

**Fix:** Launch in a lifecycle-bound or injected scope (viewModelScope, lifecycleScope, or an app scope you own and cancel) instead of GlobalScope or an inline CoroutineScope (Android coroutines best practices, 'Avoid GlobalScope').

**Bad** (`BootReceiver.kt`):

```kotlin
MainScope().launch {
            val reminders = reminderRepository.upcoming()
            reminders.forEach { scheduler.schedule(it) }
        }
```

**Good** (`LiveClockView.kt`, looks similar but is fine):

```kotlin
class LiveClockView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : AppCompatTextView(context, attrs) {

    private var scope = MainScope()

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        scope = MainScope()
        scope.launch {
            while (isActive) {
                text = formatter.format(LocalTime.now())
                delay(1_000)
            }
        }
    }

    override fun onDetachedFromWindow() {
        scope.cancel()
        super.onDetachedFromWindow()
    }
```

**Not flagged:** Work runs in `viewModelScope`, `lifecycleScope`, `rememberCoroutineScope()`, an injected or constructor-passed `CoroutineScope`, a `coroutineScope { }` / `supervisorScope { }` block, or a scope stored in a class property that is cancelled in `close()`, `onCleared()`, `onDestroy()` or `dispose()`; or no coroutine is launched.

Holdout: precision 100%, recall 100% (6 violations in the holdout set). Sources: [developer.android.com](https://developer.android.com/kotlin/coroutines/coroutines-best-practices), [detekt.dev](https://detekt.dev/docs/rules/coroutines/)

### `kt-blocking-call-not-main-safe`

Does the new code itself contain one of these blocking calls — `java.io`/`java.nio.file` file reads or writes (`File.readText`/`writeText`, `FileInputStream`, `Files.readAllBytes`), `SharedPreferences.Editor.commit()`, OkHttp `.execute()`, `HttpURLConnection`/`URL.openConnection()`, JDBC, `Future.get()`, `CountDownLatch.await()`, a DAO method whose name says it blocks (`…Blocking()`, `…Sync()`), or `Thread.sleep` on the main thread — either on the main thread (inside `viewModelScope.launch`/`lifecycleScope.launch` with no other dispatcher, `Dispatchers.Main`, a `@Composable`, or UI callbacks such as `onCreate`/`onClick`) or directly inside a `suspend fun` without `withContext(<IO or injected dispatcher>)`? Only the APIs named here count: ordinary calls to repositories, DAOs, APIs or other project functions (`repository.refresh()`, `userDao.all()`, `api.fetchConfig()`) are assumed to be main-safe suspend functions, `runBlocking` belongs to kt-runblocking-in-app-code, and a `Thread.sleep` inside a `suspend fun` is detekt's `SleepInsteadOfDelay` and does not count.

**Catches:** Blocking I/O or sleeping runs on the main thread, or inside a suspend function that callers will assume is main-safe.

**Why it matters:** Agents write `suspend fun load() = File(path).readText()` or call OkHttp `execute()` in `viewModelScope.launch` because `suspend` looks like it makes code asynchronous.

**Fix:** Wrap the blocking work in withContext(ioDispatcher) inside the function that does it, or call a main-safe suspend API (Android coroutines best practices, 'Suspend functions should be safe to call from the main thread').

**Bad** (`SettingsViewModel.kt`):

```kotlin
fun setTheme(theme: Theme) {
        _uiState.update { it.copy(theme = theme) }
        viewModelScope.launch {
            prefs.edit()
                .putString(KEY_THEME, theme.name)
                .commit()
            themeRepository.notifyChanged(theme)
        }
    }
```

**Good** (`CatalogRepository.kt`, looks similar but is fine):

```kotlin
fun observeCategory(id: String): Flow<List<Product>> =
        productDao.observeByCategory(id).map { rows -> rows.map { it.toDomain() } }

    suspend fun refreshCategory(id: String) {
        val page = api.products(id)
        productDao.upsertAll(page.items.map { it.toEntity(categoryId = id) })
    }
```

**Not flagged:** The blocking work is inside `withContext(Dispatchers.IO)` / `withContext(ioDispatcher)` / `Dispatchers.Default`, or in a coroutine launched on such a dispatcher; the calls are main-safe suspend APIs (Retrofit, Room or Ktor `suspend` functions, `delay`, DataStore) or unnamed project functions (`repo.load()`, `dao.all()`) whose blocking-ness isn't visible; the code runs on a worker thread, in `main()` or in a test; or there is no blocking call. `runBlocking { … }` is kt-runblocking-in-app-code's pattern, not this rule's. A lone `Thread.sleep` inside a `suspend fun` is detekt's `SleepInsteadOfDelay` (active by default) and does not count alone.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [developer.android.com](https://developer.android.com/kotlin/coroutines/coroutines-best-practices), [detekt.dev](https://detekt.dev/docs/rules/coroutines/)

### `kt-runblocking-in-app-code`

Does the new code call `runBlocking` inside a `suspend` function, a coroutine, a `@Composable`, an Android component (Activity, Fragment, ViewModel, Service, BroadcastReceiver), an interceptor or a request handler, instead of calling the suspend function from a coroutine scope or making the caller `suspend`?

**Catches:** `runBlocking` blocks a thread that should stay free, which can freeze the UI (ANR), starve a dispatcher or deadlock.

**Why it matters:** `runBlocking { api.fetch() }` is the most common way agents call a suspend function from non-suspend code.

**Fix:** Call the suspend function from a coroutine scope or make the caller suspend instead of runBlocking (kotlinx.coroutines runBlocking docs).

**Bad** (`MainActivity.kt`):

```kotlin
super.onCreate(savedInstanceState)
        val onboarded = runBlocking { onboardingPrefs.completed.first() }
        setContent {
```

**Good** (`Main.kt`, looks similar but is fine):

```kotlin
package com.acme.seed

import kotlinx.coroutines.runBlocking

fun main(args: Array<String>) = runBlocking {
    val db = Database.connect(args.firstOrNull() ?: "jdbc:postgresql://localhost/acme")
    val seeder = Seeder(db)
    seeder.seedProducts(count = 500)
    seeder.seedUsers(count = 50)
    println("seeded")
}
```

**Not flagged:** `runBlocking` appears only in `main()`, tests (though `runTest` is preferred), or a bridge from truly synchronous framework code that a comment explains (for example an OkHttp `Authenticator` that must return synchronously); or suspend code is called from a proper scope; or `runBlocking` is not used.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [github.com](https://github.com/Kotlin/kotlinx.coroutines/blob/master/kotlinx-coroutines-core/concurrent/src/Builders.concurrent.kt)

### `kt-catch-swallows-cancellation` _(candidate)_

Does the new code catch `Exception` or `Throwable` (or wrap suspend calls in the standard-library `runCatching`) around suspend calls inside a coroutine or `suspend` function without rethrowing `CancellationException`, so cancelling the coroutine is swallowed and the work continues? Project helpers whose name says they spare cancellation (`runSuspendCatching`, `catchNonCancellation`, `…NonCancellable…`) are not `runCatching` and do not count.

**Catches:** A broad catch or `runCatching` in suspend code can swallow `CancellationException`, so the coroutine keeps running after it is cancelled.

**Why it matters:** Agents wrap network calls in `try { … } catch (e: Exception) { _state.value = Error(e) }` inside `viewModelScope.launch` and use `runCatching` as a Result shortcut.

**Fix:** Catch specific exceptions, or rethrow CancellationException before handling the rest (Android coroutines best practices, 'Watch out for exceptions').

**Bad** (`PresencePoller.kt`):

```kotlin
suspend fun pollForever(roomId: String, onUpdate: (Presence) -> Unit) {
        while (true) {
            try {
                onUpdate(api.presence(roomId))
                delay(5_000)
            } catch (e: Exception) {
                log.warn("presence poll failed", e)
            }
        }
    }
```

**Good** (`OrdersRepository.kt`, looks similar but is fine):

```kotlin
suspend fun fetchOrders(): List<Order> = try {
        api.orders().map { it.toDomain() }.also { dao.replaceAll(it.map(Order::toEntity)) }
    } catch (e: IOException) {
        dao.all().map { it.toDomain() }
    } catch (e: HttpException) {
        if (e.code() == 404) emptyList() else throw e
    }
```

**Not flagged:** The code catches specific exceptions (`IOException`, `HttpException`, `SerializationException`); it rethrows `CancellationException` first (`catch (e: CancellationException) { throw e }` or `if (e is CancellationException) throw e`); it calls `ensureActive()` / `coroutineContext.ensureActive()` in the handler; or the catch doesn't wrap any suspend call.

Holdout: precision 83%, recall 100% (5 violations in the holdout set). Sources: [developer.android.com](https://developer.android.com/kotlin/coroutines/coroutines-best-practices), [detekt.dev](https://detekt.dev/docs/rules/coroutines/)

### `kt-flow-emit-wrong-context`

Does the new code, inside a `flow { }` builder, call `emit(...)` from within `withContext(...)`, `launch { }`, `async { }`, another thread, or a callback, instead of changing the upstream context with `.flowOn(...)` or using `channelFlow { }` / `callbackFlow { }` with `send`/`trySend`?

**Catches:** `emit` runs in a different coroutine context than the flow builder, which throws `IllegalStateException` ('Flow invariant is violated') at runtime.

**Why it matters:** Agents combine the two idioms they know best (`flow { }` and `withContext(Dispatchers.IO)`) and the code compiles.

**Fix:** Emit from the builder's own context and move the upstream work with .flowOn(dispatcher), or switch to channelFlow/callbackFlow (Kotlin docs, 'Flow context').

**Bad** (`StatsRepository.kt`):

```kotlin
withContext(Dispatchers.Default) {
            val summary = raw.toSummary()
            val ranked = summary.copy(topActivities = summary.activities.sortedByDescending { it.minutes })
            emit(ranked)
        }
```

**Good** (`StatsRepository.kt`, looks similar but is fine):

```kotlin
val summary = withContext(Dispatchers.Default) {
            raw.toSummary().let { s -> s.copy(topActivities = s.activities.sortedByDescending { it.minutes }) }
        }
        emit(summary)
```

**Not flagged:** The flow uses `.flowOn(dispatcher)`; `withContext` only wraps a computation whose result is emitted outside it (`val x = withContext(io) { load() }; emit(x)`); concurrent or callback-based emission uses `channelFlow`/`callbackFlow` with `send`/`trySend`; or the code has no `flow { }` builder.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [kotlinlang.org](https://kotlinlang.org/docs/coroutines-flow.html), [github.com](https://github.com/Kotlin/kotlinx.coroutines/blob/master/kotlinx-coroutines-core/common/src/flow/Builders.kt)

### `kt-exposed-mutable-state`

Does the new code expose a `MutableStateFlow`, `MutableSharedFlow`, `MutableLiveData`, `Channel`, or Compose `mutableStateOf`/`mutableStateListOf` holder as a public (non-private) property of a ViewModel or state holder, so other classes can change its value directly?

**Catches:** A mutable state holder is public, so views or other classes can write to it and bypass the state owner.

**Why it matters:** Agents often write `val uiState = MutableStateFlow(...)` to save the backing-property boilerplate.

**Fix:** Make the mutable holder private and expose a read-only StateFlow/SharedFlow/State (Android coroutines best practices, 'Don't expose mutable types').

**Bad** (`PlayerViewModel.kt`):

```kotlin
private val _state = MutableStateFlow(PlayerState())
    val state: StateFlow<PlayerState> = _state.asStateFlow()

    val events = MutableSharedFlow<PlayerEvent>(extraBufferCapacity = 1)

    fun onTrackEnded() {
        events.tryEmit(PlayerEvent.ShowNextUp)
    }
```

**Good** (`SearchBarState.kt`, looks similar but is fine):

```kotlin
class SearchBarState {
    var query by mutableStateOf("")
        private set
    var active by mutableStateOf(false)
        private set

    fun onQueryChange(value: String) { query = value }
    fun onActiveChange(value: Boolean) { active = value }
```

**Not flagged:** The mutable holder is `private` (e.g. `_state`) and exposed read-only as `StateFlow`/`SharedFlow`/`LiveData`/`Flow` (`asStateFlow()`, `asSharedFlow()`, `receiveAsFlow()`) or `State<T>`; a Compose `var x by mutableStateOf(...)` has `private set`; or the class isn't a state owner (a local variable, a test fake).

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [developer.android.com](https://developer.android.com/kotlin/coroutines/coroutines-best-practices), [developer.android.com](https://developer.android.com/kotlin/flow/stateflow-and-sharedflow)

### `kt-state-mutated-in-place`

Does the new code change a value held in a `StateFlow`, `LiveData` or Compose `mutableStateOf` in place — calling `add`/`remove`/`clear` on a `MutableList` or `MutableMap` inside it, assigning a property through `.value` (`_uiState.value.isRefreshing = true`, `uiState.value.loading = true`, `_state.value.items.add(x)`), or returning the same instance after mutating it from `update { }` or `.value = …` (`_state.update { it.also { s -> s.count++ } }`, `state.value = state.value.also { it.count++ }`, `apply { … }`) — instead of assigning a new value built with `copy()` or a new collection? Any line of the form `<state>.value.<property> = …` counts even when the same snippet also uses `copy()` elsewhere. Assigning a whole new value to `.value` (`count.value = count.value + 1`, `_state.value = newState`) is not in-place mutation; writing state from a `@Composable` body is kt-compose-side-effect-in-composition's pattern, not this rule's.

**Catches:** Held state is mutated in place, so the same instance is re-set (StateFlow conflates by equals) and observers or Compose don't see the change.

**Why it matters:** Agents coming from imperative code mutate `_state.value.items` directly, and the UI silently fails to update.

**Fix:** Build a new value with copy()/update { } or a new collection instead of mutating the held state (Compose state docs; StateFlow KDoc).

**Bad** (`StepCounterViewModel.kt`):

```kotlin
fun onStep() {
        _state.update { current ->
            current.also { it.steps++ ; it.lastStepAt = clock.now() }
        }
    }
```

**Good** (`CartLiveViewModel.kt`, looks similar but is fine):

```kotlin
fun add(product: Product) {
        _items.value = _items.value.orEmpty() + product
    }

    fun clear() {
        _items.value = emptyList()
    }
```

**Not flagged:** Updates assign a new value (`_state.update { it.copy(...) }`, `_state.value = _state.value.copy(...)`, `list + item`); state uses `mutableStateListOf`/`mutableStateMapOf`/`SnapshotStateList`, whose mutations are observed; or no held state is mutated. Creating `mutableStateOf(mutableListOf())` is Compose lint's `MutableCollectionMutableState` and doesn't count on its own.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [developer.android.com](https://developer.android.com/develop/ui/compose/state), [github.com](https://github.com/Kotlin/kotlinx.coroutines/blob/master/kotlinx-coroutines-core/common/src/flow/StateFlow.kt)

### `kt-collect-without-lifecycle`

Does the new code collect a Flow in an Activity or Fragment with `lifecycleScope.launch { flow.collect { ... } }` (or `collectLatest`, `launchIn(lifecycleScope)`) without `repeatOnLifecycle(...)` or `flowWithLifecycle(...)`, so collection keeps running while the UI is in the background?

**Catches:** A UI-layer flow collection isn't tied to the STARTED/RESUMED lifecycle state.

**Why it matters:** `lifecycleScope.launch { vm.state.collect { render(it) } }` is the most common flow-collection snippet from older tutorials.

**Fix:** Wrap the collect in repeatOnLifecycle(Lifecycle.State.STARTED) { … } (Android docs, 'Use Kotlin coroutines with lifecycle-aware components').

**Bad** (`MapFragment.kt`):

```kotlin
viewModel.markers
            .onEach { markers -> mapView.renderMarkers(markers) }
            .launchIn(viewLifecycleOwner.lifecycleScope)
```

**Good** (`OrdersFragment2.kt`, looks similar but is fine):

```kotlin
binding.list.adapter = adapter
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.uiState.collect { state ->
                    adapter.submitList(state.orders)
                }
            }
        }
```

**Not flagged:** Collection is wrapped in `repeatOnLifecycle(Lifecycle.State.STARTED)`, uses `flowWithLifecycle`, or happens in Compose via `collectAsStateWithLifecycle`; the collection is in a ViewModel, repository or service, not an Activity or Fragment; or a one-shot `first()` is used. Using `lifecycleScope` instead of `viewLifecycleOwner` in a Fragment is Android Lint's `UnsafeRepeatOnLifecycleDetector`, and `launchWhenStarted` is deprecated (compiler warning), so neither counts on its own.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [developer.android.com](https://developer.android.com/topic/libraries/architecture/views/coroutines-views), [googlesamples.github.io](https://googlesamples.github.io/android-custom-lint-rules/checks/index.md.html)

### `kt-viewmodel-holds-context`

Does the new code give a `ViewModel` (a class extending `ViewModel` or `AndroidViewModel`) a constructor parameter, property or stored field of an Activity-, View- or lifecycle-bound type — `Context` (other than the `Application`), `Activity`, `Fragment`, `View` or any `*View`/`*Binding`, `Resources`, `LifecycleOwner`, `Lifecycle`, `NavController` — or assign one to a ViewModel property from a setter or `init`?

**Catches:** The ViewModel keeps a reference that pins an Activity or Fragment or its views, which leaks when the ViewModel outlives them across configuration changes.

**Why it matters:** Agents pass `context` into ViewModels to show Toasts, read resources or build intents.

**Fix:** Remove the Context/View/lifecycle reference from the ViewModel; pass the values it needs in, or use Application/@ApplicationContext (Android ViewModel docs).

**Bad** (`EditorViewModel.kt`):

```kotlin
class EditorViewModel @Inject constructor(
    private val drafts: DraftRepository,
    @ActivityContext private val context: Context,
) : ViewModel() {
```

**Good** (`ShareLinkViewModel.kt`, looks similar but is fine):

```kotlin
class ShareLinkViewModel(private val links: LinkRepository) : ViewModel() {

    fun shareArticle(context: Context, articleId: String) {
        val url = links.publicUrl(articleId)
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
        context.startActivity(Intent.createChooser(send, null))
    }
```

**Not flagged:** The ViewModel receives only `Application` (e.g. `AndroidViewModel(application)`), `SavedStateHandle`, repositories or use cases, or a Hilt `@ApplicationContext context: Context`; a Context is passed as a method parameter, used and not stored; or the class isn't a ViewModel.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [developer.android.com](https://developer.android.com/topic/libraries/architecture/viewmodel), [googlesamples.github.io](https://googlesamples.github.io/android-custom-lint-rules/checks/index.md.html)

### `kt-compose-side-effect-in-composition`

Does the new code perform a side effect directly in the body of a `@Composable` function, outside `LaunchedEffect`, `DisposableEffect`, `SideEffect`, `produceState`, `remember { }` or an event lambda such as `onClick` — for example calling a ViewModel or repository method that loads, saves or sends (`viewModel.load()`, `repo.refresh()`), logging an analytics event, writing to a `MutableState`/`MutableStateFlow` that composition reads, calling `navController.navigate(...)`, or showing a Toast or Snackbar?

**Catches:** Work that should run once or in response to an event runs on every recomposition, possibly in a recomposition loop.

**Why it matters:** Agents put `LaunchedEffect`-worthy calls (`viewModel.fetch()`) straight into the composable body, and every recomposition re-triggers them.

**Fix:** Move the side effect into LaunchedEffect(key)/SideEffect or an event callback (Compose docs, 'Side-effects in Compose').

**Bad** (`CheckoutScreen.kt`):

```kotlin
if (state.orderPlaced) {
        navController.navigate("receipt/${state.orderId}")
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
```

**Good** (`ArticleScreen2.kt`, looks similar but is fine):

```kotlin
fun ArticleBody(article: Article, analytics: Analytics) {
    SideEffect {
        analytics.setCurrentScreen("article/${article.id}")
    }
    DisposableEffect(article.id) {
        val started = System.currentTimeMillis()
        onDispose { analytics.logReadTime(article.id, System.currentTimeMillis() - started) }
    }
    Text(article.body, modifier = Modifier.padding(16.dp))
```

**Not flagged:** The side effect is inside an effect handler (`LaunchedEffect(key)`, `DisposableEffect`, `SideEffect`), an event lambda (`onClick = { viewModel.save() }`), or the ViewModel's `init`; or the composable only reads state and emits UI. `launch`/`async` in composition and `StateFlow.value` reads are Compose lint's `CoroutineCreationDuringComposition` and `StateFlowValueCalledInComposition` and don't count here.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [developer.android.com](https://developer.android.com/develop/ui/compose/side-effects), [googlesamples.github.io](https://googlesamples.github.io/android-custom-lint-rules/checks/index.md.html)

## Python

### `py-sync-client-in-async`

Does the new code call a synchronous database driver, ORM, or SDK client directly inside an `async def` -- a `psycopg2`/`sqlite3`/`pymysql` cursor, a synchronous SQLAlchemy `Session` (`session.query(...)`, `session.execute(...)` with no `await`), the Django ORM's sync API (`Model.objects.get/filter/create`, iterating a QuerySet, `.save()`), `boto3`, `redis.Redis`, or a synchronous vendor client such as `openai.OpenAI()`, `anthropic.Anthropic()` or `stripe.*` -- instead of its async counterpart or `await asyncio.to_thread(...)` / `sync_to_async(...)`?

**Catches:** An `async def` body (for example a FastAPI/Starlette route declared `async def`, or a Django async view) makes a blocking database or SDK call that stalls the event loop for every other request.

**Why it matters:** agents default FastAPI handlers to `async def` and then use sync SDK/DB clients from examples -- the exact case FastAPI's docs warn about. No direct study found.

**Fix:** Use the library's async client (or declare the FastAPI route with plain `def`), or wrap the call in `await asyncio.to_thread(...)` (FastAPI docs, 'Concurrency and async / await').

**Bad** (`uploads.py`):

```python
import uuid

import boto3

s3 = boto3.client("s3")


@router.post("/avatars")
async def upload_avatar(file: UploadFile):
    key = f"avatars/{uuid.uuid4()}-{file.filename}"
    data = await file.read()
    s3.put_object(Bucket=settings.media_bucket, Key=key, Body=data, ContentType=file.content_type)
    return {"key": key, "url": f"{settings.cdn_base}/{key}"}
```

**Good** (`exports.py`, looks similar but is fine):

```python
@router.post("/exports/{export_name}")
async def push_export(export_name: str, file: UploadFile):
    data = await file.read()
    key = f"exports/{export_name}.csv"
    await asyncio.to_thread(
        s3.put_object, Bucket=settings.exports_bucket, Key=key, Body=data, ContentType="text/csv"
    )
    return {"key": key}
```

**Not flagged:** The call goes through an async library and is awaited (`AsyncSession`, `asyncpg`, `redis.asyncio`, `aioboto3`, `AsyncOpenAI`, `AsyncAnthropic`, Django's `aget`/`acreate`/`asave`/`async for`), is wrapped in `asyncio.to_thread`, `loop.run_in_executor` or `sync_to_async`, or sits in an ordinary `def` (FastAPI runs plain `def` routes in a threadpool). Quick in-memory work and logging do not count, or the code has no `async def` at all.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [docs.python.org](https://docs.python.org/3/library/asyncio-dev.html), [fastapi.tiangolo.com](https://fastapi.tiangolo.com/async/)

### `py-async-session-shared-concurrently`

Does the new code run coroutines concurrently -- with `asyncio.gather(...)`, `asyncio.TaskGroup` / `tg.create_task(...)`, or `asyncio.create_task(...)` -- where two or more of them use the same SQLAlchemy `AsyncSession`, the same `asyncpg`/`aiosqlite`/`psycopg` async connection, or the same transaction object?

**Catches:** A single session, connection or transaction is shared by tasks that run at the same time.

**Why it matters:** when asked to speed up sequential awaits (which jev-lint's own gen-sequential-independent-awaits suggests), agents wrap existing `session`-using calls in `gather`. This rule is the safety counterpart.

**Fix:** Give each concurrent task its own session or pooled connection, or await the queries sequentially (SQLAlchemy asyncio docs: an AsyncSession is not safe for concurrent tasks).

**Bad** (`importer.py`):

```python
async with asyncio.TaskGroup() as tg:
        tg.create_task(import_products(session, feed.products))
        tg.create_task(import_prices(session, feed.prices))
        tg.create_task(import_stock(session, feed.stock))
    await session.commit()
```

**Good** (`notes.py`, looks similar but is fine):

```python
session.add(note)
    await session.flush()
    await session.refresh(note, attribute_names=["author"])
    asyncio.create_task(metrics.increment("notes.created", tags={"account": str(note.account_id)}))
    await session.commit()
    return note
```

**Not flagged:** Each concurrent task opens its own session or connection (`async with async_session() as s:` inside the task, `async with pool.acquire() as conn:`); the queries on the shared session are awaited one after another; or the concurrently shared object is a pool, engine, or thread-safe HTTP client (`httpx.AsyncClient`, `aiohttp.ClientSession`), not a session or connection; or nothing runs concurrently.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [docs.sqlalchemy.org](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html)

### `py-swallowed-cancellation`

Does the new code, inside an `async def`, catch `asyncio.CancelledError` or `BaseException`, or use a bare `except:`, and then not re-raise -- returning, `continue`-ing a loop, only logging, or `pass` -- so that task cancellation (from `task.cancel()`, `asyncio.timeout`, `TaskGroup`, or server shutdown) is swallowed?

**Catches:** An async function catches cancellation and carries on instead of propagating it.

**Why it matters:** agents write long-running workers with `except asyncio.CancelledError: log; break/return` or catch-all handlers. No direct study.

**Fix:** Re-raise `CancelledError` after cleanup (or move cleanup into `finally`) so timeouts, TaskGroups and shutdown keep working (Python docs, asyncio 'Task Cancellation').

**Bad** (`poller.py`):

```python
async def poll_devices(client, device_ids, interval=15):
    while True:
        for device_id in device_ids:
            try:
                reading = await client.read(device_id)
                await store_reading(device_id, reading)
            except:
                continue
        await asyncio.sleep(interval)
```

**Good** (`sync.py`, looks similar but is fine):

```python
async def sync_forever(client, interval=30):
    while True:
        try:
            await client.push_pending()
        except Exception:
            logger.exception("sync failed; retrying in %ss", interval)
        await asyncio.sleep(interval)
```

**Not flagged:** The handler ends with a bare `raise` after cleanup; cleanup is in `finally`; the code catches only `Exception` (which does not include `CancelledError` since Python 3.8); or it awaits a task it just cancelled itself and ignores that task's `CancelledError` (`task.cancel()` then `try: await task except CancelledError: pass`); or the code is not in an `async def`.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [docs.python.org](https://docs.python.org/3/library/asyncio-task.html)

### `py-side-effect-in-transaction`

Does the new code send an email, make an HTTP request, publish a message, or enqueue a background task (`send_mail`, `requests.post`, `httpx`, `task.delay(...)`, `.apply_async(...)`, `producer.send`) inside a database transaction block -- Django `with transaction.atomic():` or an `@transaction.atomic` function, SQLAlchemy `with session.begin():` / `async with session.begin():`, or `async with conn.transaction():` -- instead of after the commit?

**Catches:** An external side effect runs inside the transaction, so it can fire for data that later rolls back, or a worker can run before the row it needs is committed.

**Why it matters:** agents add `.delay(obj.id)` right after `obj.save()` wherever the save is, including inside `atomic`.

**Fix:** Run the side effect after commit, e.g. `transaction.on_commit(lambda: send_receipt.delay(order.id))` (Django docs, 'Performing actions after commit').

**Bad** (`deals.py`):

```python
async with session.begin():
        deal = await session.get(Deal, deal_id)
        deal.stage = "won"
        deal.amount = amount
        await http.post(f"{settings.erp_url}/sales-orders", json={"deal_id": deal.id, "amount": str(amount)})
```

**Good** (`leads.py`, looks similar but is fine):

```python
def convert_lead(session, lead):
    with session.begin():
        contact = Contact(name=lead.name, email=lead.email, account_id=lead.account_id)
        session.add(contact)
        session.add(OutboxMessage(topic="lead.converted", payload={"lead_id": lead.id, "email": lead.email}))
        lead.status = "converted"
    return contact
```

**Not flagged:** The side effect is registered with `transaction.on_commit(...)` or runs after the transaction block ends; the block only reads and writes the database; or the message goes to an outbox table in the same database inside the transaction; or there is no transaction block.

Holdout: precision 80%, recall 100% (4 violations in the holdout set). Sources: [docs.djangoproject.com](https://docs.djangoproject.com/en/5.2/topics/db/transactions/)

### `py-read-modify-write-race`

Does the new code read a counter, balance, stock, or quota field from a database record, change it in Python, and save it back -- e.g. `product.stock -= qty; product.save()` or `account.balance = account.balance + amount; session.commit()` -- without an atomic database update (Django `F()` / `.update(stock=F('stock') - qty)`, SQLAlchemy `update(...).values(col=Model.col - x)`) or a row lock (`select_for_update()`, `with_for_update()`)?

**Catches:** A read-modify-write of a shared numeric field can lose concurrent updates.

**Why it matters:** inventory, credit and balance code written by agents is typically naive read-modify-write.

**Fix:** Update the field atomically in the database (`F('stock') - qty`, `update().values(...)`) or lock the row with `select_for_update()` first (Django docs, 'Avoiding race conditions using F()').

**Bad** (`models.py`):

```python
class Coupon(models.Model):


    def redeem(self):
        if self.redemptions >= self.max_redemptions:
            raise CouponExhausted(self.code)
        self.redemptions += 1
        self.save(update_fields=["redemptions"])
```

**Good** (`builder.py`, looks similar but is fine):

```python
def build_draft(account, usage_rows):
    invoice = Invoice(account=account, status=Invoice.Status.DRAFT, total=Decimal("0"))
    for row in usage_rows:
        invoice.total += row.quantity * row.unit_price
    invoice.save()
    return invoice
```

**Not flagged:** The update happens in the database (`F()` expression, `update()` with a column expression, SQL `SET x = x - :n`), the row is locked with `select_for_update`/`with_for_update` in the same transaction, an optimistic version check guards the save, or the field is not shared state (a new object being built, a local variable, a per-request draft); or no stored field is updated.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [docs.djangoproject.com](https://docs.djangoproject.com/en/5.2/ref/models/expressions/), [docs.djangoproject.com](https://docs.djangoproject.com/en/5.2/topics/db/optimization/)

### `py-pydantic-construct-bypass`

Does the new code create a pydantic model with `Model.model_construct(...)` or `Model.construct(...)` from data that came from outside the program -- a request body, `json.loads`, `response.json()`, a file, a queue message, or `**data` from any of these -- which skips all validation?

**Catches:** External data is turned into a model with `model_construct`/`construct`, so its fields are never validated.

**Why it matters:** agents reach for `model_construct` to silence validation errors. Rare but high impact.

**Fix:** Use `Model.model_validate(data)` for anything that came from outside the program (pydantic docs, 'Creating models without validation').

**Bad** (`consumer.py`):

```python
data = json.loads(message.body)
    order = OrderMessage.model_construct(**data)
    await fulfil(order)
    await message.ack()
```

**Good** (`users.py`, looks similar but is fine):

```python
def to_user_out(row) -> UserOut:
    # rows come from our own users table and were validated on write
    return UserOut.model_construct(id=row.id, email=row.email, display_name=row.display_name, created_at=row.created_at)
```

**Not flagged:** The model is built with `Model(...)`, `Model.model_validate(...)`, or `model_validate_json(...)`; or `model_construct` is used only on data the code itself just built or already validated, such as values read back from its own database; or no model is constructed. Also fine: `model_construct` on data that was just validated (the output of `model_validate`/`model_validate_json`, `.model_dump()` of a validated model, or values the code itself computed).

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [pydantic.dev](https://pydantic.dev/docs/validation/latest/concepts/models/)

## Ruby

### `rb-side-effect-before-commit`

Does the new code send email (`deliver_now`), make an HTTP/API call, charge a payment, publish to a queue, or enqueue a job (`perform_async`, `perform_in`, `perform_later`, `deliver_later`) either inside an `ActiveRecord::Base.transaction`/`Model.transaction`/`with_lock` block, or from an `after_save`, `after_create`, `after_update` or `after_destroy` callback -- instead of after commit (`after_commit`, `after_create_commit`, `after_update_commit`, or after the transaction block)?

**Catches:** A side effect runs inside the transaction: a job can run before its data is committed, and an email or charge can fire even though the transaction later rolls back.

**Why it matters:** agents add `after_create :send_welcome_email` and `perform_async` inside `transaction do` blocks.

**Fix:** Move the side effect to `after_commit` (`after_create_commit`/`after_update_commit`) or after the transaction block.

**Bad** (`ticket.rb`):

```ruby
after_update :notify_slack, if: :saved_change_to_status?

  private

  def notify_slack
    SlackClient.new.post_message(
      channel: "#support",
      text: "Ticket ##{id} moved to #{status}"
    )
  end
```

**Good** (`issue.rb`, looks similar but is fine):

```ruby
def call
    refund = nil
    Refund.transaction do
      refund = @order.refunds.create!(amount_cents: @amount_cents, reason: @reason)
      @order.update!(status: "refunded")
    end
    RefundMailer.issued(refund).deliver_later
    refund
  end
```

**Not flagged:** The side effect is in `after_commit`/`after_*_commit` or after the transaction block; `perform_later`/`deliver_later` is used in a job class or snippet that shows `enqueue_after_transaction_commit` enabled; the transaction or callback only changes database rows or the record's own attributes; or there is no transaction or save callback.

Holdout: precision 83%, recall 100% (5 violations in the holdout set). Sources: [guides.rubyonrails.org](https://guides.rubyonrails.org/active_job_basics.html), [github.com](https://github.com/sidekiq/sidekiq/wiki/Best-Practices)

### `rb-read-modify-write-race`

Does the new code read a counter, balance, stock, or quota attribute from an ActiveRecord record, change it in Ruby, and save it -- `account.balance -= amount; account.save!`, `product.update(stock: product.stock - qty)` -- without a row lock (`with_lock`, `lock!`, `Model.lock.find`) or an atomic SQL update (`update_counters`, `increment!`/`decrement!`, `update_all("stock = stock - ?", qty)`)?

**Catches:** A read-modify-write of a shared numeric column can lose concurrent updates.

**Why it matters:** agents implement credits/inventory as plain attribute arithmetic.

**Fix:** Do the change in SQL (`update_counters` / conditional `update_all`) or wrap the read-modify-write in `record.with_lock { ... }` (Rails Guides, 'Locking Records for Update').

**Bad** (`wallets_controller.rb`):

```ruby
def top_up
    wallet = current_user.wallet
    amount = params.require(:amount_cents).to_i
    wallet.update!(balance_cents: wallet.balance_cents + amount)
    redirect_to wallet_path, notice: "Wallet topped up."
  end
```

**Good** (`article.rb`, looks similar but is fine):

```ruby
class Article < ApplicationRecord
  belongs_to :author, class_name: "User", counter_cache: true

  def record_view!
    increment!(:views_count)
  end

  def self.record_shares(ids)
    ids.each { |id| update_counters(id, shares_count: 1) }
  end
end
```

**Not flagged:** The change is done in SQL (`update_counters`, `increment!`/`decrement!`, a conditional `update_all`), the record is locked first (`with_lock`, `lock!`, `lock.find`), optimistic locking (`lock_version`) is shown, or the record is new or not shared (being built, a form object); or no stored numeric field is changed.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [guides.rubyonrails.org](https://guides.rubyonrails.org/active_record_querying.html)

### `rb-memoize-nil-or-false`

Does the new code memoize with `@var ||= ...` where the value can legitimately be `nil` or `false` -- for example `find_by`, `exists?`, `any?`, `present?`, a predicate method, `ENV[...]`, `dig`, `detect`, or an API call that may return nil -- so the expensive work reruns on every call?

**Catches:** `||=` memoizes a result that can be nil/false, so memoization silently does nothing in that case.

**Why it matters:** agents apply `||=` memoization to everything.

**Fix:** Use `return @x if defined?(@x); @x = ...` when the value can be nil or false.

**Bad** (`stripe_customer_lookup.rb`):

```ruby
def customer
    @customer ||= Stripe::Customer.list(email: @user.email, limit: 1).data.first
  end
```

**Good** (`organization.rb`, looks similar but is fine):

```ruby
def sso_provider
    return @sso_provider if defined?(@sso_provider)

    @sso_provider = identity_providers.find_by(enabled: true)
  end
```

**Not flagged:** The memoized value is never nil/false (a relation, a `find` that raises, a new object, a collection, a string built by the code), or the code uses `return @var if defined?(@var)` or a `key?` check; or no `||=` memoization is used.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `rb-rescue-swallowed`

Does the new code have a `rescue` (bare `rescue`, `rescue => e`, `rescue StandardError`, or a modifier `rescue nil`) whose body is empty, only a comment, only `nil`, or only returns a default value, without logging the error, reporting it (`Rails.logger.error`, `Rails.error.report`, `Sentry.capture_exception`, `Honeybadger.notify`), or re-raising?

**Catches:** A broad rescue silently hides the failure.

**Why it matters:** agents add `rescue => e; nil` / `rescue StandardError; {}` to make errors go away.

**Fix:** Rescue the specific error you expect, or report it (`Rails.error.report(e)`) before continuing.

**Bad** (`geocoder_service.rb`):

```ruby
def coordinates_for(address)
    client.geocode(address)
  rescue StandardError
    nil
  end
```

**Good** (`orders_controller.rb`, looks similar but is fine):

```ruby
def show
    @order = current_user.orders.find(params[:id])
  rescue ActiveRecord::RecordNotFound
    redirect_to orders_path, alert: "Order not found."
  end
```

**Not flagged:** The rescue logs, reports, or re-raises the error; or it rescues a specific class (`ActiveRecord::RecordNotFound`, `JSON::ParserError`, `Timeout::Error`, `ArgumentError`) with deliberate handling; or there is no rescue.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

## Rust

### `rs-blocking-call-in-async`

Does the new code make a blocking call directly inside an `async fn` or `async` block — `std::thread::sleep`, `std::fs::*`, `std::net`, `std::process::Command::output()`/`status()`, `std::sync::mpsc::Receiver::recv`, `reqwest::blocking`, a synchronous database client, `futures::executor::block_on`/`Handle::block_on`, or a long CPU-bound loop (hashing passwords, compressing, parsing large files) — instead of the async equivalent or `tokio::task::spawn_blocking`?

**Catches:** Async code blocks the executor thread, stalling every other task scheduled on it (or panics, in the case of `block_on` inside a runtime).

**Why it matters:** Agents use `std::fs::read_to_string` and `std::thread::sleep` in async handlers because that is the std API they know best.

**Fix:** Use the async API or move the blocking work into tokio::task::spawn_blocking (Tokio docs, 'CPU-bound tasks and blocking code').

**Bad** (`cache.rs`):

```rust
pub async fn warm(&self) -> anyhow::Result<()> {
        let products = futures::executor::block_on(self.repo.list_active())?;
        let mut guard = self.entries.write().await;
        for p in products {
            guard.insert(p.sku.clone(), p);
        }
        Ok(())
    }
```

**Good** (`poller.rs`, looks similar but is fine):

```rust
pub async fn poll_until_ready(client: &reqwest::Client, url: &str) -> anyhow::Result<()> {
        let status = client.get(url).send().await?.status();
        tokio::time::sleep(Duration::from_secs(2)).await;
```

**Not flagged:** It uses async APIs (`tokio::time::sleep`, `tokio::fs`, `tokio::process`, async reqwest, sqlx) or moves blocking work into `spawn_blocking` / `block_in_place`; the blocking call is in a normal (non-async) `fn`; or the work is brief in-memory computation or logging. Holding a `std::sync::Mutex` guard across `.await` is clippy's `await_holding_lock` and doesn't count here.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [docs.rs](https://docs.rs/tokio/latest/tokio/#cpu-bound-tasks-and-blocking-code), [github.com](https://github.com/rust-lang/rust-clippy/blob/master/clippy_lints/src/declared_lints.rs)

### `rs-select-cancel-unsafe`

Does the new code use `tokio::select!` inside a loop where a branch awaits a future that Tokio documents as not cancellation safe — `AsyncReadExt::read_exact`, `read_to_end`, `read_to_string`, `AsyncWriteExt::write_all` (can lose data), or `tokio::sync::Mutex::lock`, `RwLock::read`/`write`, `Semaphore::acquire`, `Notify::notified` (lose their queue position) — created fresh on every iteration, so the partial work is dropped whenever another branch wins?

**Catches:** A non-cancel-safe operation is raced in `select!` and recreated each loop iteration, so bytes or queue position are silently lost when another branch completes first.

**Why it matters:** `loop { select! { r = stream.read_exact(&mut buf) => …, _ = shutdown.recv() => break } }` is a natural-looking pattern agents write for protocol loops. Data loss only shows under load.

**Fix:** Race only cancel-safe operations in select!, or create the future once outside the loop and select on &mut fut (Tokio select! docs, 'Cancellation safety').

**Bad** (`uploader.rs`):

```rust
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

        let mut body = Vec::new();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                res = reader.read_to_end(&mut body) => {
                    res?;
                    break;
                }
                _ = heartbeat.tick() => {
                    tracing::info!(bytes = body.len(), "upload still in progress");
                }
            }
        }
```

**Good** (`reader.rs`, looks similar but is fine):

```rust
tokio::select! {
            n = rd.read_buf(&mut buf) => {
                if n? == 0 {
                    return Ok(());
                }
                let _ = tx.send(buf.split().freeze()).await;
            }
            _ = stop.changed() => return Ok(()),
        }
```

**Not flagged:** Branches use cancel-safe methods (`mpsc::Receiver::recv`, `broadcast::Receiver::recv`, `watch::Receiver::changed`, `TcpListener::accept`, `AsyncReadExt::read`/`read_buf`, `AsyncWriteExt::write`/`write_buf`, `StreamExt::next`); the non-cancel-safe future is created once outside the loop, pinned (`tokio::pin!`) and polled as `&mut fut`; the operation runs in its own spawned task that reports back over a channel; or `select!` isn't inside a loop.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [docs.rs](https://docs.rs/tokio/latest/tokio/macro.select.html)

### `rs-spawned-task-error-lost`

Does the new code call `tokio::spawn`, `tokio::task::spawn`, or `std::thread::spawn` with a body that can fail (it uses `?`, returns a `Result`, or calls something that returns `Result`) while dropping the returned `JoinHandle` and not logging or handling the error inside the task, so any failure disappears silently?

**Catches:** A fallible spawned task's handle is discarded, and its error is neither logged nor handled.

**Why it matters:** Agents spawn background work with `tokio::spawn(async move { do_thing().await? ; Ok::<_, Error>(()) });` and never look at the result.

**Fix:** Await or track the JoinHandle (JoinSet), or handle and log the error inside the spawned task.

**Bad** (`audit.rs`):

```rust
pub async fn record(pool: &PgPool, event: AuditEvent) {
    let pool = pool.clone();
    tokio::spawn(async move {
        let _ = sqlx::query("INSERT INTO audit_log (actor_id, action, payload) VALUES ($1, $2, $3)")
            .bind(event.actor_id)
            .bind(&event.action)
            .bind(sqlx::types::Json(&event.payload))
            .execute(&pool)
            .await;
    });
}
```

**Good** (`lib.rs`, looks similar but is fine):

```rust
pub fn start_uptime_gauge(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(10));
            loop {
                ticker.tick().await;
                self.uptime_secs.fetch_add(10, Ordering::Relaxed);
            }
        });
    }
```

**Not flagged:** The `JoinHandle` is stored and awaited or joined; the task is added to a `JoinSet` or `TaskTracker` whose results are checked; the task logs or handles its own errors (`if let Err(e) = work().await { tracing::error!(…) }`); or the task body can't fail.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [docs.rs](https://docs.rs/tokio/latest/tokio/task/struct.JoinHandle.html)

### `rs-unsigned-subtraction-underflow`

Does the new code subtract from an unsigned integer (`usize`, `u32`, `u64`, including `.len()`, indices, counts, byte offsets, or Unix timestamps held in `u64`) where the right-hand side can be larger than the left and nothing in the snippet rules that out — e.g. `v.len() - 1` on a vector that may be empty, `end - start` on values from input, `remaining -= n` — instead of using `checked_sub`/`saturating_sub` or a prior guard?

**Catches:** An unsigned subtraction can underflow, which panics in debug builds and silently wraps to a huge value in release builds.

**Why it matters:** It is the dominant Rust runtime failure in LLM output in the one study found (C-grade), and agents write `len() - 1` reflexively.

**Fix:** Use checked_sub/saturating_sub or guard the subtraction so the right side can't exceed the left (Rust Reference, 'Integer overflow').

**Bad** (`quota.rs`):

```rust
pub fn consume(&mut self, n: u32) -> bool {
        self.remaining -= n;
        self.used += n;
        self.remaining > 0
    }
```

**Good** (`timer.rs`, looks similar but is fine):

```rust
pub fn elapsed_ms(start: std::time::Instant) -> u128 {
    (std::time::Instant::now() - start).as_millis()
}

pub fn balance_delta(before: i64, after: i64) -> i64 {
    after - before
}
```

**Not flagged:** A guard in the snippet guarantees the left side is at least the right (`if !v.is_empty()`, `if a >= b`, a loop bound like `for i in 1..v.len()`); the code uses `checked_sub`/`saturating_sub`/`wrapping_sub` or `abs_diff`; the operands are signed; or they are constants known to be ordered. `Instant`/`Duration` subtraction belongs to clippy's `unchecked_time_subtraction` and doesn't count.

Holdout: precision 100%, recall 80% (5 violations in the holdout set). Sources: [doc.rust-lang.org](https://doc.rust-lang.org/reference/behavior-not-considered-unsafe.html#integer-overflow)

### `rs-unchecked-unsafe-on-unvalidated`

Does the new code call an unsafe unchecked API — `get_unchecked`/`get_unchecked_mut`, `str::from_utf8_unchecked`/`String::from_utf8_unchecked`, `unwrap_unchecked`, `Vec::set_len`, `slice::from_raw_parts(_mut)`, `char::from_u32_unchecked`, `NonZero*::new_unchecked`, `mem::transmute` — on a value whose precondition (index in bounds, valid UTF-8, `Some`/`Ok`, initialized length, valid pointer and length, valid bit pattern) isn't established by a check or construction visible in the snippet, e.g. an index or bytes from a function parameter, user input, a file or the network?

**Catches:** Undefined behavior depends on an unchecked precondition that nothing verified, typically added 'for performance'.

**Why it matters:** Agents reach for `get_unchecked`/`from_utf8_unchecked` when asked to optimize and justify them with confident but wrong SAFETY comments.

**Fix:** Use the checked API (get, from_utf8, ?) or validate the precondition right before the unsafe call (std docs: out-of-bounds get_unchecked is undefined behavior; Rustonomicon).

**Bad** (`auth.rs`):

```rust
let value = headers.get(AUTHORIZATION);
    // middleware already rejected requests without the header
    let value = unsafe { value.unwrap_unchecked() };
```

**Good** (`palette.rs`, looks similar but is fine):

```rust
pub fn color_at(palette: &[u32], i: usize) -> Option<u32> {
    if i < palette.len() {
        // SAFETY: bounds checked above
        Some(unsafe { *palette.get_unchecked(i) })
    } else {
        None
    }
}
```

**Not flagged:** The snippet establishes the precondition right before the call (`if i < v.len()`, bytes produced from a `&str`/`String`, `set_len` after writing exactly that many elements, a pointer and length taken from a live slice); the enclosing function is an `unsafe fn` whose `# Safety` doc passes the obligation to callers; or the checked API (`get`, `from_utf8`, `?`) is used. A missing `// SAFETY:` comment is clippy's `undocumented_unsafe_blocks`; a comment alone doesn't make the precondition checked.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [doc.rust-lang.org](https://doc.rust-lang.org/std/primitive.slice.html#method.get_unchecked), [doc.rust-lang.org](https://doc.rust-lang.org/nomicon/working-with-unsafe.html)

### `rs-http-client-per-call`

Does the new code build a new `reqwest::Client` (`Client::new()` or `Client::builder()…build()`), or call the `reqwest::get(...)` convenience function, inside a loop or inside a function that sends a request and is called repeatedly, instead of creating one client and reusing it?

**Catches:** A new HTTP client, with its own connection pool and TLS setup, is created for each request or iteration.

**Why it matters:** Agents write self-contained `async fn fetch_x(url) { let client = Client::new(); … }` helpers.

**Fix:** Create one reqwest::Client and reuse it (clone it; the pool is shared) (reqwest Client docs).

**Bad** (`crawler.rs`):

```rust
for url in &seed_urls {
        let body = reqwest::get(url.as_str()).await?.text().await?;
        let links = extract_links(&body);
        frontier.extend(links);
```

**Good** (`thumbs.rs`, looks similar but is fine):

```rust
let client = reqwest::Client::new();
    futures::future::join_all(urls.into_iter().map(|u| {
        let client = client.clone();
        async move { Ok(client.get(u).send().await?.bytes().await?) }
    }))
    .await
```

**Not flagged:** One client is created at startup or outside the loop and passed in, cloned (cheap; the pool is shared), or stored in app state or a `OnceLock`/`LazyLock`; the code is a one-shot `main` making a single request; or no reqwest client is created.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [docs.rs](https://docs.rs/reqwest/latest/reqwest/struct.Client.html)

## Swift

### `swiftui-observedobject-owned`

Does the new code create a new object inline for an `@ObservedObject` property (e.g. `@ObservedObject var model = ProfileModel()`), so the view owns an object SwiftUI may recreate on every re-render, instead of using `@StateObject` (or `@State` with an `@Observable` class)?

**Catches:** An `@ObservedObject` property is initialized with a new instance inside the view.

**Fix:** Use `@StateObject` (or `@State` for `@Observable`) for objects the view creates.

**Bad** (`CountdownView.swift`):

```swift
let title: String
    @ObservedObject var timerModel = CountdownModel(duration: 60)

        Text(title)
        Text(timerModel.remainingText)
            .font(.system(.largeTitle, design: .monospaced))
```

**Not flagged:** Owned objects use `@StateObject` or `@State`, and `@ObservedObject` is only used for objects passed in from outside.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `swiftui-state-not-private`

Does the new code declare a SwiftUI `@State` or `@StateObject` property that is not `private` and is meant to be set by the parent view (for example `@State var user: User` with no default value, filled in through the initializer)?

**Catches:** View-owned state is exposed and initialized from outside, so later parent updates are silently ignored.

**Fix:** Make @State private; take parent data as `let` or `@Binding`.

**Bad** (`GroceryListView.swift`):

```swift
@State var items: [GroceryItem]

            GroceryListView(items: store.items)
```

**Not flagged:** All `@State`/`@StateObject` properties are `private` with local defaults, and data from the parent comes in as `let`, `@Binding`, or an environment value.

Holdout: precision 100%, recall 80% (5 violations in the holdout set).

### `swiftui-expensive-body`

Does the new code do expensive work inside a SwiftUI view's `body` (or a computed property or helper that `body` calls each render) — creating a `DateFormatter`, `NumberFormatter`, `JSONDecoder`, or regex; sorting or filtering a large collection; decoding data; or reading files?

**Catches:** Work that should be cached or done once runs on every render of the view.

**Fix:** Cache formatters as static properties and move heavy work into the model or `.task`.

**Bad** (`LibraryView.swift`):

```swift
var body: some View {
        let matches = library.songs.filter {
            query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)
        }
        List(matches) { song in
            SongRow(song: song)
        }
        .searchable(text: $query)
    }
```

**Not flagged:** Formatters and decoders are static or cached, heavy work happens in the model or a `.task`, or the body only lays out views.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `swiftui-task-in-onappear`

Does the new code start async work with `Task { ... }` inside a SwiftUI `.onAppear` modifier instead of using the `.task` modifier, which cancels automatically when the view disappears?

**Catches:** `.onAppear { Task { await ... } }` launches work that is never cancelled.

**Fix:** Use `.task { await ... }` so the work is cancelled with the view.

**Bad** (`AvatarView.swift`):

```swift
.onAppear {
            Task { await loadAvatar() }
        }
```

**Not flagged:** Async work starts in `.task` / `.task(id:)`, or the Task is stored and cancelled in `.onDisappear`, or there is no async work in onAppear.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `swift-escaping-closure-retain-cycle`

Does the new code store or register an escaping closure that captures `self` strongly inside a class — a `Timer` block, a `NotificationCenter` observer block, a Combine `sink` stored in `cancellables`, or a closure assigned to a property — without `[weak self]` or `[unowned self]`, creating a retain cycle?

**Catches:** A long-lived closure owned (directly or indirectly) by self references self strongly.

**Fix:** Capture `[weak self]` in stored or registered closures and cancel them when done.

**Bad** (`PlayerViewModel.swift`):

```swift
private var statusObservation: NSKeyValueObservation?
        statusObservation = player.observe(\.timeControlStatus, options: [.new]) { player, _ in
            self.isPlaying = player.timeControlStatus == .playing
        }
```

**Not flagged:** Such closures capture `[weak self]`/`[unowned self]`, or the closures are non-escaping or one-shot (map, forEach, withAnimation, a single URLSession or DispatchQueue call), or the code is a SwiftUI struct.

Holdout: precision 100%, recall 86% (7 violations in the holdout set).

### `swift-blocking-main-thread`

Does the new code do blocking work on the main thread or in UI code — `Data(contentsOf:)` or `String(contentsOf:)` on a network URL, `Thread.sleep`, `DispatchSemaphore.wait()`, or a synchronous network request — inside a view, view controller, or `@MainActor` type?

**Catches:** UI code blocks the main thread waiting on I/O, a sleep, or a semaphore.

**Fix:** Use async APIs (URLSession.data, Task.sleep) or move the work off the main actor.

**Bad** (`AboutView.swift`):

```swift
Button("Check for updates") {
                let url = URL(string: "https://updates.example.com/ios/latest.txt")
                if let url, let text = try? String(contentsOf: url, encoding: .utf8) {
                    latestVersion = text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
```

**Not flagged:** Blocking I/O happens off the main actor, or the code uses async APIs such as `URLSession.data(from:)` and `Task.sleep`.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `swift-continuation-misuse`

Does the new code use `withCheckedContinuation`, `withCheckedThrowingContinuation`, or an unsafe continuation in a way where some path could resume the continuation more than once, or never resume it (for example a callback that can fire repeatedly, or an early `return` / error branch that skips `resume`)?

**Catches:** At least one code path resumes twice or not at all.

**Fix:** Make sure every path resumes exactly once; guard repeated callbacks and resume on errors.

**Bad** (`SyncStatusWaiter.swift`):

```swift
func waitForSyncCompletion() async {
        await withCheckedContinuation { continuation in
            _ = NotificationCenter.default.addObserver(
                forName: .syncDidFinish,
                object: nil,
                queue: .main
            ) { _ in
                continuation.resume()
            }
        }
    }
```

**Not flagged:** Every path resumes exactly once, or no continuations are used. A continuation stored in a property that another call could overwrite, or a bridge without a cancellation handler, are separate rules and do not count here: answer yes only if a path in the added code itself calls resume twice or returns without resuming.

Holdout: precision 79%, recall 85% (13 violations in the holdout set).

### `swift-unprotected-shared-state`

Does the new code declare mutable state that is shared across threads or tasks — a `static var`, a global `var`, or a mutable property on a class singleton or cache used from background queues or concurrent tasks — without an actor, a lock, a serial queue, or `@MainActor` protecting it?

**Catches:** Shared mutable state can be read and written concurrently with no synchronization.

**Fix:** Put the state in an actor, guard it with a lock, or isolate it to the main actor.

**Bad** (`RequestPerformer.swift`):

```swift
var inFlightRequestCount = 0

func performRequest(_ request: URLRequest, completion: @escaping (Result<Data, Error>) -> Void) {
    inFlightRequestCount += 1
    URLSession.shared.dataTask(with: request) { data, _, error in
        inFlightRequestCount -= 1
```

**Not flagged:** Shared state is inside an actor, guarded by a lock/serial queue/Mutex, main-actor isolated, or immutable (`let`).

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `swiftui-foreach-unstable-id`

Does the new code use SwiftUI `ForEach` with `id: \.self` over values that may not be unique or that change (model structs, user-editable strings, duplicate values), or over `indices` of a collection that can be modified, instead of a stable identifier?

**Catches:** ForEach identifies rows by value or index for data that can change or repeat.

**Fix:** Make the model Identifiable with a stable id and use it in ForEach.

**Bad** (`CartItemsView.swift`):

```swift
struct CartItem: Hashable {

            ForEach(viewModel.cartItems, id: \.self) { item in
                CartItemRow(item: item, onQuantityChange: { viewModel.setQuantity($0, for: item) })
            }
```

**Not flagged:** Rows use an `Identifiable` stable id, or `id: \.self` is used on a fixed set of unique constants (enum cases, a static range).

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `swift-dispatch-in-async`

Does the new code call `DispatchQueue.main.async` (or `DispatchQueue.global().async`) from inside an `async` function or a `Task`, mixing Grand Central Dispatch into Swift concurrency code instead of using `await MainActor.run` or `@MainActor`?

**Catches:** Async/await code hops threads with DispatchQueue instead of actors.

**Fix:** Use `await MainActor.run { }` or mark the type/function `@MainActor`.

**Bad** (`InventoryViewController.swift`):

```swift
@objc private func refreshTapped() {
        Task {
            let items = try? await repository.fetchItems()
            DispatchQueue.main.async {
                self.items = items ?? []
                self.tableView.reloadData()
            }
        }
    }
```

**Not flagged:** Async code uses `MainActor.run`, `@MainActor`, or actors; DispatchQueue appears only in callback-based (non-async) code, or not at all.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `swift-continuation-cancellation`

Does the new code wrap a callback- or delegate-based operation (an upload, download, request, location or permission call) in `withCheckedContinuation` / `withCheckedThrowingContinuation` without `withTaskCancellationHandler` or any other way to cancel the underlying operation, so cancelling the Swift task leaves that work running and the caller waiting?

**Catches:** A continuation bridges long-running callback work but cancelling the task does not cancel the work.

**Fix:** Wrap the bridge in withTaskCancellationHandler and cancel the underlying operation in onCancel.

**Bad** (`RecordStore.swift`):

```swift
func record(id: CKRecord.ID) async throws -> CKRecord {
    try await withCheckedThrowingContinuation { continuation in
        let operation = CKFetchRecordsOperation(recordIDs: [id])
        operation.qualityOfService = .userInitiated
        operation.fetchRecordsResultBlock = { _ in }
        operation.perRecordResultBlock = { _, result in
            continuation.resume(with: result)
        }
        database.add(operation)
    }
}
```

**Not flagged:** The bridge uses `withTaskCancellationHandler` (or registers a cancel hook) to stop the underlying operation, or the wrapped call is instant and cannot be cancelled, or no continuation is used.

Holdout: precision 92%, recall 100% (12 violations in the holdout set).

### `swift-continuation-stored-overwrite`

Does the new code store a continuation in an instance property (for example `self.continuation = continuation`) where a second concurrent call can overwrite the first stored continuation before it is resumed, leaving the first caller suspended forever?

**Catches:** A single stored continuation property can be replaced by a concurrent call, stranding the earlier caller.

**Fix:** Reject or queue calls while a continuation is pending, or key continuations by request id.

**Bad** (`PeripheralConnector.swift`):

```swift
private var connectContinuation: CheckedContinuation<Void, Error>?

func connect(to peripheral: CBPeripheral) async throws {
    try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            connectContinuation = continuation
            central.connect(peripheral, options: nil)
        }
    } onCancel: {
        central.cancelPeripheralConnection(peripheral)
    }
}

func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connectContinuation?.resume()
    connectContinuation = nil
}

func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    connectContinuation?.resume(throwing: error ?? BLEError.connectionFailed)
    connectContinuation = nil
}
```

**Not flagged:** Concurrent calls are rejected or queued while one is pending, continuations are kept per request (for example in a dictionary keyed by id), or the continuation is only a local variable.

Holdout: precision 90%, recall 100% (9 violations in the holdout set).

### `swift-actor-reentrancy-stale-state`

Does the new code, inside an `actor` or a `@MainActor`/global-actor-isolated type (such as a view model), check or read isolated state, then `await` something, then act on that check without re-checking it — for example `if cache[key] == nil { let v = await fetch(key); cache[key] = v }` or `if let session, session.isValid { return session }` followed by `let renewed = try await renew(); session = renewed` (concurrent callers fetch or refresh twice), `guard !isLoading else { return }` with an `await` on the next lines before `isLoading = true` is set, or `let current = balance; await audit(); balance = current - amount`? Look for a guard/if on a stored property, then an `await`, then a write to that same property or flag.

**Catches:** An invariant checked or a value read before an `await` is assumed to still hold after it, although other calls can run on the actor during the suspension and change it.

**Why it matters:** Agents write the natural check-await-set shape (duplicate fetches, double submits, lost updates) and Swift 6 compiling cleanly makes them trust it. Grade: inference from how common the pattern is in cache/loader code; no controlled study found.

**Fix:** Re-check state after every await, or record the in-flight Task or flag before awaiting (SE-0306, 'Actor reentrancy').

**Bad** (`TokenStore.swift`):

```swift
actor TokenStore {
    func validToken() async throws -> String {
        if let token, !token.isExpired {
            return token.value
        }
        let refreshed = try await client.refresh(using: refreshToken)
        token = refreshed
        return refreshed.value
    }
```

**Good** (`InboxViewModel.swift`, looks similar but is fine):

```swift
func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            threads = try await api.threads()
            lastError = nil
        } catch {
            lastError = error
        }
    }
```

**Not flagged:** State is re-read or re-checked after each `await`; the in-flight flag or marker is set before the first `await` (`isLoading = true` then `await`); in-flight work is deduplicated by storing a `Task` in the dictionary before awaiting it; the read-modify-write happens in a synchronous method with no `await` in between; or there is no `await` between the read and the dependent write. Data races on non-isolated types are the Swift 6 compiler's job and do not count.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [github.com](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0306-actors.md), [github.com](https://github.com/swiftlang/swift-book/blob/main/TSPL.docc/LanguageGuide/Concurrency.md)

### `swift-unchecked-sendable-unsynchronized`

Does the new code add `@unchecked Sendable` to a type, or mark a variable `nonisolated(unsafe)`, when the mutable state it covers (`var` stored properties, a mutable class reference, a collection) has no lock, `Mutex`, `OSAllocatedUnfairLock`, `NSLock`, serial `DispatchQueue` or atomic guarding it in the added code, so the annotation only silences Swift 6 strict-concurrency errors?

**Catches:** An escape hatch is added over mutable state with no visible synchronization, so the data race the compiler reported is still there.

**Why it matters:** When a build fails under Swift 6, the shortest way to green is adding `@unchecked Sendable` or `nonisolated(unsafe)`, and agents take it (D-grade reports; plausible given how often these annotations show up in pre-2024 training code).

**Fix:** Make it an actor or a value type, or guard every mutable property with a Mutex or lock, instead of silencing the checker (Swift 6 migration guide, 'Manual Synchronization').

**Bad** (`ResponseCache.swift`):

```swift
enum ResponseCache {
    nonisolated(unsafe) static var entries: [URL: CachedResponse] = [:]

    static func store(_ response: CachedResponse, for url: URL) {
        entries[url] = response
    }
}
```

**Good** (`Decoders.swift`, looks similar but is fine):

```swift
nonisolated(unsafe) let iso8601Decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return decoder
}()
```

**Not flagged:** Every mutable stored property is only read or written while holding a lock, `Mutex` or serial queue shown in the code; the type has only `let` properties of Sendable types (the annotation is redundant, not unsafe); `nonisolated(unsafe)` is on a `let`, or on a variable with a comment naming the lock or queue that guards it; or there is no `@unchecked Sendable` / `nonisolated(unsafe)`. A plain `static var` or global `var` with neither annotation belongs to `swift-unprotected-shared-state`, not this rule.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [github.com](https://github.com/swiftlang/swift-migration-guide/blob/main/Guide.docc/CommonProblems.md)

### `swift-cancellation-swallowed-in-loop`

Does the new code contain a repeating loop in async code (`while true`, `while !done`, `repeat { } while`, a retry or polling loop) that waits with `try? await Task.sleep(...)` (or `try? await clock.sleep`, or a `catch` that ignores the sleep's error and continues) and never checks `Task.isCancelled` or calls `try Task.checkCancellation()`, so once the task is cancelled the sleep returns immediately and the loop spins forever?

**Catches:** A polling or retry loop throws away the `CancellationError` from the sleep and has no other cancellation check, so cancellation turns it into a busy loop.

**Why it matters:** Agents write `while true { await refresh(); try? await Task.sleep(for: .seconds(30)) }` polling loops in `.task` or view models because `try?` is the quickest way to satisfy `throws`.

**Fix:** Use `try await Task.sleep` so cancellation exits the loop, or check `Task.isCancelled` on every iteration (Task.sleep docs: it throws CancellationError when the task is cancelled).

**Bad** (`HeartbeatSender.swift`):

```swift
func start() async {
        repeat {
            await socket.send(.heartbeat(Date()))
            do {
                try await clock.sleep(for: .seconds(10))
            } catch {
                continue
            }
        } while socket.isOpen
    }
```

**Good** (`BackgroundSync.swift`, looks similar but is fine):

```swift
func runForever() async {
        while !Task.isCancelled {
            await syncPendingChanges()
            try? await Task.sleep(for: .seconds(15))
        }
    }
```

**Not flagged:** The loop uses `try await Task.sleep` and lets the error end it; the loop condition or body checks `Task.isCancelled` / calls `Task.checkCancellation()`; the loop `break`s or `return`s when the sleep throws; the loop is a `for await` over an async sequence; or `try? await Task.sleep` appears once, not inside a loop.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [developer.apple.com](https://developer.apple.com/documentation/swift/task/sleep(for:tolerance:clock:)), [github.com](https://github.com/swiftlang/swift-book/blob/main/TSPL.docc/LanguageGuide/Concurrency.md)

### `swift-unstructured-task-in-async-context`

Does the new code create an unstructured `Task { ... }` or `Task.detached { ... }` that is neither stored nor awaited, either (a) once per iteration of a `for`/`while` loop to process items concurrently, or (b) inside code that is already async (an `async` function, a SwiftUI `.task { }` modifier, or a task-group child) where the work could just be awaited or run with `withTaskGroup` or `async let`, so cancelling the surrounding task no longer reaches it and its errors are lost? A `Task` started inside an `AsyncStream`/`AsyncThrowingStream` builder closure to feed the continuation is not async context; whether it is cancelled on termination is swift-asyncstream-missing-ontermination's pattern, not this rule's.

**Catches:** Fire-and-forget tasks are spawned from async code or per loop iteration, escaping structured cancellation and error propagation.

**Why it matters:** Agents bring GCD-era habits into async code (`for x in xs { Task { await upload(x) } }`) and wrap awaits in `Task { }` to get around 'async call in a function that does not support concurrency' errors, even when the caller is already async.

**Fix:** Await the work directly or use withTaskGroup/async let; if it must be unstructured, store the Task and cancel it (TSPL, 'Unstructured Concurrency').

**Bad** (`ProfileRefresher.swift`):

```swift
Task.detached(priority: .utility) {
            try await self.analytics.track(.profileRefreshed)
            try await self.cache.persist(self.profile)
        }
```

**Good** (`BackupService.swift`, looks similar but is fine):

```swift
// Deliberately unstructured: the initial backup must keep running after
        // the onboarding screen is dismissed and its task is cancelled.
        Task.detached(priority: .background) { [store] in
            await store.performInitialBackup()
        }
```

**Not flagged:** Work is awaited directly or uses `async let`, `withTaskGroup` or `withThrowingTaskGroup`; the `Task` is stored (`let task = Task { … }`, `self.loadTask = Task { … }`) and later awaited or cancelled; a single `Task { }` starts from synchronous code such as a button action, `init` or a delegate callback; or a comment explains why the work must outlive the caller. `Task { }` inside SwiftUI `.onAppear` belongs to `swiftui-task-in-onappear`, not this rule.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [github.com](https://github.com/swiftlang/swift-book/blob/main/TSPL.docc/LanguageGuide/Concurrency.md), [github.com](https://github.com/swiftlang/swift-migration-guide/blob/main/Guide.docc/RuntimeBehavior.md)

### `swift-asyncstream-missing-ontermination`

Does the new code build an `AsyncStream` or `AsyncThrowingStream` (including `makeStream()`) whose continuation is fed by something that keeps running — a `NotificationCenter` observer, a delegate, a `Timer`, a KVO `observe`, a Combine `sink`, a location, sensor or socket start call, or a spawned `Task` — without setting `continuation.onTermination` to remove, stop or cancel it?

**Catches:** When the consumer stops iterating or its task is cancelled, the observer, timer or task behind the stream keeps running and holding resources.

**Why it matters:** Agents often wrap NotificationCenter or delegate APIs in AsyncStream and yield from the callback but leave out onTermination. Grade: inference; it is the same teardown gap as the existing continuation-cancellation rule.

**Fix:** Set continuation.onTermination to tear down the observer, timer or task (AsyncStream docs, QuakeMonitor example).

**Bad** (`WorkoutClock.swift`):

```swift
var ticks: AsyncStream<Date> {
        AsyncStream { continuation in
            let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                continuation.yield(Date())
            }
            RunLoop.main.add(timer, forMode: .common)
        }
```

**Good** (`OnboardingSteps.swift`, looks similar but is fine):

```swift
func steps() -> AsyncStream<OnboardingStep> {
        AsyncStream { continuation in
            for step in [OnboardingStep.welcome, .permissions, .profile, .done] {
                continuation.yield(step)
            }
            continuation.finish()
        }
    }
```

**Not flagged:** `continuation.onTermination = { ... }` removes the observer, invalidates the timer, stops monitoring or cancels the task; the stream yields a fixed set of values and calls `finish()` right away; the producer is a single one-shot callback that calls `finish()`; or no AsyncStream is built.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [developer.apple.com](https://developer.apple.com/documentation/swift/asyncstream)

### `swift-observation-tracking-one-shot`

Does the new code call `withObservationTracking { ... } onChange: { ... }` to keep something continuously in sync (UI, cache, persistence, logging on every change) without re-registering, meaning `onChange` never calls the tracking function again, even though `onChange` fires only once, on the first change?

**Catches:** Observation is set up once and silently stops after the first change.

**Why it matters:** The name reads like a subscription, so agents treat it as one. Volume is low because few edits call this API; each hit is a real bug.

**Fix:** Re-register inside onChange by calling the tracking function again, or iterate `Observations { }` instead (SE-0395: onChange is called on the first change).

**Bad** (`ModelChangeLogger.swift`):

```swift
func logChanges(of library: Library) {
        withObservationTracking {
            _ = library.books.count
        } onChange: {
            logger.debug("library changed")
        }
    }
```

**Good** (`NowPlayingUpdater.swift`, looks similar but is fine):

```swift
private func track() {
        withObservationTracking {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = player.nowPlayingInfo
        } onChange: { [weak self] in
            DispatchQueue.main.async {
                self?.track()
            }
        }
    }
```

**Not flagged:** `onChange` calls the function that runs `withObservationTracking` again (re-arming it, often via `Task { @MainActor in self.observe() }`); the code iterates the `Observations { }` async sequence instead; or only a single notification is wanted (a one-shot wait that a comment or the surrounding code makes clear).

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [github.com](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0395-observability.md), [developer.apple.com](https://developer.apple.com/documentation/observation/observations)

### `swiftui-state-default-heavy-init`

Does the new code give a SwiftUI `@State` property a default value whose initializer, as written in the snippet, has side effects or does heavy work — network, file or database I/O, building a `ModelContainer`, creating an `AVPlayer`, socket or `Timer` that starts running, decoding a bundled JSON file, or calling a `load…()`/`fetch…()`/`connect…()` function — even though SwiftUI evaluates that default every time it re-creates the view struct?

**Catches:** The `@State` default-value expression does I/O, starts work or does expensive setup each time the view initializes.

**Why it matters:** during Observation migrations. Agents mechanically replace `@StateObject var x = X()` (lazy autoclosure) with `@State var x = X()` (eager), which moves side-effecting initializers onto every view init.

**Fix:** Keep @State defaults cheap; create heavy objects in .task into an optional @State, or once in the App, and pass them down (SwiftUI State docs).

**Bad** (`ChatRoomView.swift`):

```swift
@State private var messages: [Message] = []
    @State private var connection = ChatConnection.connect(to: URL(string: "wss://chat.acme.dev/rooms")!)
    @State private var ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
```

**Good** (`PhotoLibraryView.swift`, looks similar but is fine):

```swift
@StateObject private var library = PhotoLibraryStore(loadFromDisk: true)
    @State private var selection: Set<Photo.ID> = []
    @State private var sortOrder: SortOrder = .newestFirst
```

**Not flagged:** The default is a literal, an empty collection or a plain initializer of a lightweight model (`@State private var model = FeedModel()`); heavy setup is deferred to `.task { }` into an optional (`@State private var model: FeedModel?`); the property is in the `App` struct; or the property uses `@StateObject`, whose initializer SwiftUI evaluates lazily.

Holdout: precision 80%, recall 100% (4 violations in the holdout set). Sources: [developer.apple.com](https://developer.apple.com/documentation/swiftui/state)

## Typescript

### `react-derived-state-effect`

Does the new code use a React `useEffect` whose job is to compute a value from props or other state and store it with a state setter (for example `useEffect(() => { setFullName(first + ' ' + last) }, [first, last])` or filtering a list into another state variable), when that value could simply be calculated during render?

**Catches:** An effect only derives a value from existing props/state and copies it into another piece of state.

**Fix:** Delete the effect and extra state; compute the value during render (useMemo if it is expensive).

**Bad** (`SignupNameFields.tsx`):

```ts
const [lastName, setLastName] = useState("");
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    setFullName(`${firstName} ${lastName}`.trim());
  }, [firstName, lastName]);
```

**Not flagged:** No such effect. Effects that talk to something outside React (fetching, subscriptions, timers, the DOM, localStorage) are fine, and so is computing the value directly or with useMemo. Copying a prop into state and re-syncing it when the prop changes is a different problem (mirrored props) and does not count here, and neither does state the user can edit afterwards.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `react-effect-missing-cleanup`

Does the new code have a React `useEffect` that starts something ongoing — `setInterval`, a `setTimeout` that later updates state, `addEventListener`, a subscription, a WebSocket, or an EventSource — without returning a cleanup function that stops it?

**Catches:** An effect starts a timer, listener, socket, or subscription and never returns a function that clears, removes, closes, or unsubscribes it.

**Fix:** Return a cleanup from the effect that clears the timer, removes the listener, or closes the connection.

**Bad** (`RoomPresence.tsx`):

```ts
const [online, setOnline] = useState<string[]>([]);

  useEffect(() => {
    presenceClient.subscribe(roomId, (members) => {
      setOnline(members.map((member) => member.userId));
    });
  }, [roomId]);
```

**Not flagged:** Every ongoing thing started in an effect is stopped in the returned cleanup, or the code starts nothing ongoing in an effect.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `react-effect-fetch-race`

Does the new code make an HTTP request (with `fetch`, axios, or an API-client function that returns a Promise) inside a React `useEffect` and then set state with the response without protecting against stale or unmounted responses — no `AbortController`, and no `ignore`/`cancelled` flag that the cleanup sets and the code checks before calling the setter?

**Catches:** An effect awaits a request and then calls a state setter unconditionally, so a slow earlier response can overwrite a newer one.

**Fix:** Use an AbortController (or an `ignore` flag set in the cleanup) and skip setState for stale responses.

**Bad** (`InvoiceList.tsx`):

```ts
useEffect(() => {
    fetchInvoices(customerId).then(setInvoices);
  }, [customerId]);
```

**Not flagged:** The effect aborts the request or checks a cancelled flag in cleanup, or the data comes from a library such as React Query or SWR, or there is no HTTP request inside an effect. WebSockets, EventSource, timers, and subscriptions are not HTTP requests and do not count here. Repeated or delayed requests (polling, debounced or per-keystroke requests, retry loops) belong to the separate async-overlap rule and do not count here.

Holdout: precision 76%, recall 100% (13 violations in the holdout set).

### `react-effect-for-event`

Does the new code use a React `useEffect` to react to a specific user action — for example watching a `submitted`, `saved`, or `clicked` state flag and then sending a request, navigating, or showing a toast — when that logic belongs in the event handler that set the flag?

**Catches:** An effect exists mainly to run action logic after a flag set by an event handler flips.

**Fix:** Move the logic into the event handler and drop the flag state and effect.

**Bad** (`SettingsForm.tsx`):

```ts
const [saved, setSaved] = useState(false);

  async function handleSave() {
    await updateSettings(form);
    setSaved(true);
  }

  useEffect(() => {
    if (saved) {
      toast.success("Settings saved");
      router.push("/dashboard");
    }
  }, [saved, router]);
```

**Not flagged:** User-action logic runs in the event handlers themselves, or effects only synchronize with external systems.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `react-state-mutation`

Does the new code mutate React state in place — calling `push`, `splice`, `sort`, or `reverse` on an array held in state, or assigning to a property of a state object — instead of building a new array or object for the setter?

**Catches:** State is changed in place (e.g. `todos.push(item); setTodos(todos)` or `user.name = v; setUser(user)`).

**Fix:** Create a new array/object (spread, map, filter, toSorted) and pass it to the setter.

**Bad** (`NotificationSettings.tsx`):

```ts
function handleEmailToggle(enabled: boolean) {
    settings.notifications.email = enabled;
    setSettings({ ...settings });
  }
```

**Not flagged:** State updates always create new values (spread, map, filter, `toSorted`, a copy then sort), or the mutated value is not React state.

Holdout: precision 100%, recall 83% (6 violations in the holdout set).

### `react-index-key`

Does the new code render a list in React using the array index as the `key` (`key={i}`, `key={index}`, `key={idx}`) for items that can be added, removed, reordered, filtered, or edited?

**Catches:** A dynamic list uses the index as its key.

**Fix:** Use a stable unique id from the item as the key.

**Bad** (`ResultsList.tsx`):

```ts
<ul className="results">
        {results.map((result, index) => (
          <li key={index}>
            <a href={result.url}>{result.title}</a>
            <p>{result.snippet}</p>
          </li>
        ))}
      </ul>
```

**Not flagged:** Keys come from stable ids, or the list is a fixed, never-changing set of items.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `react-props-mirrored-in-state`

Does the new code copy a prop into `useState` and then use a `useEffect` to keep that state in sync with the prop (e.g. `const [value, setValue] = useState(props.value); useEffect(() => setValue(props.value), [props.value])`)?

**Catches:** A prop is duplicated into state and an effect re-syncs it when the prop changes.

**Fix:** Use the prop directly, lift the state up, or reset the component with a `key`.

**Bad** (`QuantityStepper.tsx`):

```ts
import { useEffect, useState } from "react";

  const [qty, setQty] = useState(quantity);

  useEffect(() => {
    setQty(quantity);
  }, [quantity]);
```

**Not flagged:** Props are used directly, the component is fully controlled or uses a `key` to reset, or no prop is mirrored into state.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `ts-unvalidated-external-data`

Does the new code itself parse raw external data — calling `res.json()`, `JSON.parse(...)`, reading `localStorage`/`sessionStorage`, or reading `event.data` from a message — and then cast it with `as SomeType` or assign it to a typed variable or return type, without checking its shape at runtime?

**Catches:** External data is cast or assigned straight to a domain type with no runtime validation.

**Fix:** Validate external data with a schema or type guard before trusting its type.

**Bad** (`preferences.ts`):

```ts
export function loadPreferences(): Preferences {
  const raw = localStorage.getItem(PREFERENCES_KEY);
  if (!raw) return DEFAULT_PREFERENCES;
  return { ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Preferences) };
}
```

**Good** (`JobProgress.tsx`, looks similar but is fine):

```ts
import { ProgressEventSchema } from "./schemas";

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.addEventListener("progress", (event) => {
      const { percent } = ProgressEventSchema.parse(JSON.parse(event.data));
      setProgress(percent);
    });
  }, [jobId]);
```

**Not flagged:** The parsed data is validated (zod/valibot/arktype schema, a type-guard function, manual field checks) or kept as `unknown` and narrowed. Calling a typed API-client function, React Query, or SWR does not count, because this code does not parse raw data itself. If none of res.json, JSON.parse, storage reads, or event.data appear, the answer is no.

Holdout: precision 100%, recall 100% (8 violations in the holdout set).

### `ts-sequential-await-loop`

Does the new code await independent asynchronous calls one at a time inside a loop (e.g. `for (const id of ids) { users.push(await fetchUser(id)) }`), when the calls do not depend on each other and could run concurrently with `Promise.all` or a bounded pool?

**Catches:** A loop awaits unrelated requests sequentially with no stated reason.

**Fix:** Run independent calls with Promise.all (or a bounded concurrency helper).

**Bad** (`healthChecks.ts`):

```ts
const results: HealthResult[] = [];
  for (const target of targets) {
    const startedAt = performance.now();
    const ok = await pingTarget(target.url, { timeoutMs: target.timeoutMs });
    results.push({ name: target.name, ok, latencyMs: performance.now() - startedAt });
  }
  return results;
```

**Not flagged:** Calls run concurrently, each call depends on the previous result, or the code explains that sequencing or rate-limiting is intentional (retries, pagination cursors, backoff).

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `ts-boolean-trap`

Does the new code call or define a function with two or more boolean positional parameters, so call sites read like `createUser(name, true, false)` and the meaning of each flag is unclear?

**Catches:** A function signature or call passes several bare boolean flags positionally.

**Fix:** Replace boolean flags with an options object (`{ sendEmail: true }`) or separate functions.

**Bad** (`ReportToolbar.tsx`):

```ts
function handleExport() {
    exportReport(rows, true, false);
  }
```

**Not flagged:** Flags are passed in a named options object, or functions take at most one boolean.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `react-async-overlap`

Does the new code start repeated or delayed requests — polling with `setInterval` or a loop, a debounced `setTimeout`, or a new request on every keystroke or prop change — where a slower earlier response can still arrive after a newer request and overwrite state, because nothing cancels or ignores the older ones (no AbortController, no request id or sequence check, no clearing of the previous timer's request)?

**Catches:** Repeated or delayed requests can race: an out-of-date response may land last and set state.

**Fix:** Abort or ignore stale requests (AbortController or a request id) and only start a new poll after the previous one finishes.

**Bad** (`ShippingForm.tsx`):

```ts
const onCountryChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const code = e.target.value;
    setCountry(code);
    const res = await fetch(`/api/regions/${code}`);
    setRegions(await res.json());
  };
```

**Not flagged:** Earlier requests are aborted, ignored by id/sequence, or a new poll only starts after the previous one finishes; or the code makes a single one-off request (a single request inside one effect run belongs to the fetch-race rule); or there are no repeated or delayed requests. A single request that runs once per effect run is the separate fetch-race rule, not this one.

Holdout: precision 100%, recall 100% (10 violations in the holdout set).

### `react-effect-notifies-parent`

Does the new code use a React `useEffect` or `useLayoutEffect` whose job is to call a callback prop — `onChange`, `onSelect`, `onValueChange`, `onFetched`, `onToggle` — with the component's own state after that state changes (e.g. `useEffect(() => { onChange(isOn) }, [isOn, onChange])`), instead of calling the callback in the event handler that changed the state?

**Catches:** An Effect exists only to forward local state to a parent callback.

**Why it matters:** Agents wrapping third-party inputs keep internal state and 'sync' it upward with an Effect, causing double renders and loops when the parent feeds the value back.

**Fix:** Call the parent's callback in the same event handler that updates the state (react.dev 'You Might Not Need an Effect', notifying parent components).

**Bad** (`DateRangePicker.tsx`):

```ts
useEffect(() => {
    if (from && to) {
      onValueChange({ from, to })
    }
  }, [from, to])
```

**Good** (`ResizablePanel.tsx`, looks similar but is fine):

```ts
export function ResizablePanel({ width, onWidthChange, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => onWidthChange(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [onWidthChange]);
```

**Not flagged:** The callback is called from the event handler; the Effect synchronizes with an external system (subscription, DOM observer, WebSocket) and reports that system's events; the component is controlled and never mirrors the value in local state. Effects that only call a state setter belong to react-derived-state-effect, and Effects reacting to a submitted/clicked flag belong to react-effect-for-event.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [react.dev](https://react.dev/learn/you-might-not-need-an-effect), [react.dev](https://react.dev/reference/eslint-plugin-react-hooks)

### `react-use-uncached-promise`

Does the new code call React's `use()` with a Promise created during render in the same component — `use(fetch(…))`, `use(getData())`, `use(fetchX().then(…))`, or an inline async IIFE — instead of a Promise received as a prop or from context, created in a Server Component, or returned from a cache that yields the same Promise across renders?

**Catches:** `use()` receives a Promise that is re-created on every render, so the component keeps suspending.

**Why it matters:** `use` is new in React 19 and agents pattern-match it as 'await in a component', writing `use(fetch(url))` directly.

**Fix:** Pass use() a cached Promise: create it in a Server Component or a cached function, not during render (react.dev use reference).

**Bad** (`UserCard.tsx`):

```ts
import { use } from 'react'
import { getUser } from '@/api/users'

export function UserCard({ userId }: { userId: string }) {
  const user = use(getUser(userId))
  return (
    <div className="card">
      <img src={user.avatarUrl} alt="" width={40} height={40} />
      <span>{user.displayName}</span>
    </div>
  )
}
```

**Good** (`Header.tsx`, looks similar but is fine):

```ts
export function Header() {
  const theme = use(ThemeContext);
  const { user } = use(SessionContext);
```

**Not flagged:** The Promise comes from props, context, a module-level cache or `cache()`d function, or a data library that returns a stable Promise; `use` is called with a Context (`use(ThemeContext)`); a Server Component `await`s instead; there is no `use()` call.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [react.dev](https://react.dev/reference/react/use)

### `react-hydration-unsafe-render`

Does the new code make a component's rendered output depend on the browser during render — branching JSX on `typeof window !== 'undefined'`, or reading `window.*` (`innerWidth`, `matchMedia`, `location`), `localStorage`/`sessionStorage`, `navigator`, or `document` in the component body or in a `useState` initializer — in a component that is server-rendered and hydrated (Next.js, Remix/React Router framework mode, `hydrateRoot`)?

**Catches:** Server HTML and the first client render can differ because render reads browser-only state.

**Why it matters:** Hydration-mismatch errors are among the most common errors agents hit in Next.js, and the usual generated 'fix' is a `typeof window` branch that causes them.

**Fix:** Read browser-only values after hydration (useEffect or useSyncExternalStore with getServerSnapshot) so server and client render the same markup (react.dev hydrateRoot).

**Bad** (`Hero.tsx`):

```ts
export function Hero() {
  const isMobile = window.innerWidth < 768
  return (
    <section className={isMobile ? 'hero hero--stacked' : 'hero'}>
```

**Good** (`BuyButton.tsx`, looks similar but is fine):

```ts
function handleClick() {
  if (typeof window !== "undefined" && window.plausible) {
    window.plausible("ticket_click", { props: { tierId } });
  }
  onBuy(tierId);
```

**Not flagged:** The browser read happens inside `useEffect`, an event handler, or `useSyncExternalStore` with a `getServerSnapshot`; the component is rendered client-only (`dynamic(…, { ssr: false })`, a Vite/CRA single-page app, React Native); the check guards only a side effect, not rendered output.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [react.dev](https://react.dev/reference/react-dom/client/hydrateRoot)

### `react-useformstatus-same-component` _(candidate)_

Does the new code call `useFormStatus()` in the same component that renders the `<form>` it is meant to track (the hook call and the `<form action={…}>` are in one component body), so `pending` never becomes true?

**Catches:** `useFormStatus` is called in the component that renders the form.

**Why it matters:** New React 19 API; agents trained mostly on pre-19 code call it next to the form like `useState`, producing a button that never shows pending.

**Fix:** Move useFormStatus into a child component rendered inside the <form> (react.dev useFormStatus pitfall).

**Bad** (`ContactForm.tsx`):

```ts
export function ContactForm() {
  const { pending, data } = useFormStatus()
  return (
    <form action={sendMessage} aria-busy={pending}>
      {pending && <p>Sending message from {data?.get('email')?.toString()}…</p>}
```

**Good** (`PendingOverlay.tsx`, looks similar but is fine):

```ts
"use client";

import { useFormStatus } from "react-dom";

export function PendingOverlay({ message = "Working…" }: { message?: string }) {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <div role="status" className="overlay">
      <span className="spinner" /> {message}
    </div>
  );
}
```

**Not flagged:** `useFormStatus` is called in a child component rendered inside the `<form>` (e.g. a `SubmitButton`); the component renders no `<form>`; pending state comes from `useActionState` or `useTransition` instead.

Holdout: precision 100%, recall 75% (4 violations in the holdout set). Sources: [react.dev](https://react.dev/reference/react-dom/hooks/useFormStatus)

### `react-transition-state-after-await`

Does the new code call a state setter after an `await` inside an async `startTransition(async () => { … })` callback (from `useTransition` or the `startTransition` import) without wrapping those post-`await` updates in another `startTransition(…)`?

**Catches:** State updates that follow an await inside a transition are not marked as transitions.

**Why it matters:** Agents adopt async transitions from React 19 examples and set state after the fetch in the same callback.

**Fix:** Wrap each state update that follows an await in its own startTransition (react.dev useTransition caveat).

**Bad** (`SettingsTabs.tsx`):

```ts
function selectTab(next: Tab) {
    startTransition(async () => {
      const loaded = await loadTabData(userId, next)
      setData(loaded)
      setTab(next)
    })
  }
```

**Good** (`TabBar.tsx`, looks similar but is fine):

```ts
function selectTab(next: Tab) {
  startTransition(() => {
    setTab(next);
  });
```

**Not flagged:** Updates after the await are wrapped in a nested `startTransition`; updates happen only before the first `await`; the flow uses `useActionState`, a form `action`, or `useOptimistic`; there is no await in the transition.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [react.dev](https://react.dev/reference/react/useTransition)

### `react-lazy-initial-state`

Does the new code call an expensive function and pass its result directly as the initial value of `useState(…)` or `useReducer(…)` — the call's parentheses appear inside the hook's parentheses, e.g. `useState(JSON.parse(localStorage.getItem(k)))`, `useState(createInitialTodos())`, `useState(buildIndex(items))`, `useState(new Map(entries.map(…)))` — so it runs on every render, instead of passing an initializer function (`useState(() => …)` or the bare function reference `useState(createInitialTodos)`, which is correct and does not count)?

**Catches:** An expensive initial-state expression is evaluated on every render.

**Why it matters:** Agents persist state with `useState(JSON.parse(localStorage.getItem('x') ?? '[]'))`, re-parsing storage on each render.

**Fix:** Pass an initializer function to useState so the expensive work runs once (react.dev useState, 'Avoiding recreating the initial state').

**Bad** (`TodoList.tsx`):

```ts
import { useState } from 'react'
import { createInitialTodos } from './seed'

export function TodoList() {
  const [todos, setTodos] = useState(createInitialTodos())
  const [text, setText] = useState('')

  return (
    <>
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={() => { setText(''); setTodos([{ id: todos.length, text }, ...todos]) }}>Add</button>
      <ul>{todos.map((t) => <li key={t.id}>{t.text}</li>)}</ul>
    </>
  )
}
```

**Good** (`ExhibitFilter.tsx`, looks similar but is fine):

```ts
import { useState } from "react";
import { buildFacetTree } from "./facets";

export function ExhibitFilter({ exhibits }: { exhibits: Exhibit[] }) {
  const [facets] = useState(() => buildFacetTree(exhibits));
  const [selected, setSelected] = useState<string[]>([]);
  const [openedAt] = useState(new Date());
  const [count] = useState(exhibits.length);

  return <FacetList facets={facets} selected={selected} onChange={setSelected} openedAt={openedAt} total={count} />;
}
```

**Not flagged:** Cheap initial values (literals, props, `props.items.length`, `new Date()`, `[]`, `{}`); an initializer function (`useState(() => …)`, `useState(fn)`); `useReducer(reducer, arg, init)` with an init function; no state hook.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [react.dev](https://react.dev/reference/react/useState)
