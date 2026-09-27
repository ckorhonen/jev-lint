# Deterministic coverage: what a repo's tooling already checks

Jev rules are for what **no deterministic tool can check**. Before proposing a rule,
prove that no linter, type checker, formatter or pattern scanner in *this* repo already
enforces it. A duplicate costs a model call per edit and can contradict the linter.

Legend in the tables: **D** = on in the tool's default or its common recommended preset;
**O** = opt-in (must be named in config); **T** = needs type information (slower
type-aware mode; often skipped in pre-commit). Where no rule ID is given, the
capability exists but the exact ID varies by version, so don't cite one.

---

## 1. Find what is actually enabled

Installed is not enabled, and enabled is not enforced. For each tool, answer three questions:
1. Which config file applies to the files the agent edits (nearest file, overrides, per-path ignores)?
2. Which rules does that config turn on (preset plus additions, minus disables)?
3. Does anything **run** it and fail on it (CI job, pre-commit hook, build phase)?

**The best evidence is a probe.** Feed a minimal violating snippet to the repo's own tool.
Prefer stdin so no file is written in the repo (if a tool needs a real file, use a scratch copy of its config outside the repo), and run the tool as the repo pins it (`bunx`/`npx`,
`uv run`, `bundle exec`, Mint or SPM plugin). Don't install anything just to probe.

| Tool | Resolve effective config | Probe a snippet |
|---|---|---|
| ESLint | `eslint --print-config src/x.ts` | `eslint --stdin --stdin-filename src/x.ts < snippet` |
| Biome | read `biome.json(c)`; `biome explain <rule>` if available | stdin mode prints no diagnostics in Biome 2.x. Copy `biome.json` to a scratch dir, put the snippet at the same relative path (e.g. `src/x.ts`, so `files.includes` matches), run the repo's own `node_modules/.bin/biome lint src/x.ts` there. Note whether it reports an error or only a warning |
| tsc | `tsc --showConfig -p tsconfig.json` | typecheck command from package.json scripts |
| Ruff | `ruff check --show-settings src/x.py` | `ruff check --stdin-filename src/x.py - < snippet` |
| SwiftLint | `swiftlint rules` (enabled / opt-in columns) | `swiftlint lint --use-stdin < snippet` |
| golangci-lint | `golangci-lint linters` | run on a temp package in a scratch dir that copies the config |
| RuboCop | `rubocop --show-cops <Cop>` | `rubocop --stdin app/x.rb < snippet` |
| Clippy / rustc | read `Cargo.toml` `[lints]`, crate-root `#![...]` | none cheap; rely on config reading |

### JavaScript / TypeScript
- **ESLint flat config** (`eslint.config.{js,mjs,cjs,ts}`) is an array. Later entries override
  earlier ones, and each entry can scope itself with `files`/`ignores`. Look for spread
  presets: `js.configs.recommended`, `tseslint.configs.recommended | strict | recommendedTypeChecked | strictTypeChecked | stylistic(TypeChecked)`,
  `reactHooks.configs.recommended` (or `configs['recommended-latest']` / `configs.flat.recommended`), `jsxA11y.flatConfigs.recommended`,
  `importPlugin.flatConfigs.recommended`, `eslintPluginUnicorn.configs.recommended` (or `configs['flat/recommended']` in older versions).
  **Type-aware rules run only if** `parserOptions.project` or `projectService` is set.
- **Legacy config** (`.eslintrc.{js,cjs,json,yml}`, or `eslintConfig` in package.json) uses `extends` strings (`eslint:recommended`,
  `plugin:@typescript-eslint/recommended`, `plugin:react-hooks/recommended`, `plugin:jsx-a11y/recommended`,
  `plugin:import/recommended`, `plugin:unicorn/recommended`, `next/core-web-vitals`, `airbnb`, `standard`),
  plus `overrides` and `.eslintignore`. Shareable configs (`airbnb`, `@company/eslint-config`) live in
  `node_modules`, so read them there before assuming.
- **Config-driven rules are the big hidden coverage.** `no-restricted-syntax` (AST selectors),
  `no-restricted-imports`, `no-restricted-globals`, `no-restricted-properties`,
  `@typescript-eslint/no-restricted-types`, and local plugins (`eslint-plugin-local-rules`, an
  `eslint/rules/` directory, `rulesdir`). Read their options: a team-specific ban often lives there.
- **Oxlint** (`.oxlintrc.json`) mirrors many ESLint, typescript-eslint, React, jsx-a11y, import and unicorn rules under the same names.
- **Biome** (`biome.json`/`biome.jsonc`): `linter.enabled`, `linter.rules.recommended` (default true),
  then per group `a11y | complexity | correctness | nursery | performance | security | style | suspicious`.
  A rule is `"off" | "warn" | "error"` or `{ "level": ..., "options": ... }`. `overrides[]` apply per glob.
  Biome v2 adds GritQL plugins (`plugins: [...]`), which are custom pattern rules; read them.
- **Prettier** (`.prettierrc*`, `prettier.config.*`, `"prettier"` in package.json) and Biome's `formatter`
  cover all formatting. Never propose a layout, quote, semicolon or import-order rule.
- **tsc**: `strict: true` turns on `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`,
  `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `useUnknownInCatchVariables`, `alwaysStrict`.
  **`strict` does NOT include** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`. Follow `extends` chains (for example `@tsconfig/strictest`).
  **Bundlers (Vite, esbuild, Bun, swc, Next's SWC) strip types without checking them.** tsc only counts
  if `tsc --noEmit`, `vue-tsc` or `next build`'s type check actually runs.
- **Architecture**: `dependency-cruiser` (`.dependency-cruiser.*`), `eslint-plugin-boundaries`,
  `import/no-restricted-paths`, and Nx `@nx/enforce-module-boundaries` already enforce layer and import boundaries.

### Swift
- **SwiftLint** (`.swiftlint.yml`, also nested per directory; `parent_config` / `child_config`):
  - `disabled_rules` removes default rules; `opt_in_rules` adds opt-in ones; `analyzer_rules` run only
    under `swiftlint analyze` (needs a compiler log, rarely in CI).
  - `only_rules` **replaces** the whole default set, so only the rules it lists are on.
  - `custom_rules` are regex rules, often used for bans like `print(` or `NSLog`. Read them.
  - `excluded` / `included` paths.
  - **Where it runs:** a build phase in `project.pbxproj` (`swiftlint` in a `shellScript`), the
    `SwiftLintBuildToolPlugin` in `Package.swift`, fastlane `swiftlint(...)`, CI or pre-commit.
    A build phase **without** `--strict` leaves warnings non-blocking.
- **swift-format** (`.swift-format`, JSON): `"rules": { "NeverForceUnwrap": false, ... }`. Safety rules like
  `NeverForceUnwrap`, `NeverUseForceTry`, `NeverUseImplicitlyUnwrappedOptionals`, `AllPublicDeclarationsHaveDocumentation`
  are off unless set to true. SwiftFormat (`.swiftformat`, nicklockwood) is formatting only.
- **Compiler**: Swift 6 language mode or `SWIFT_STRICT_CONCURRENCY = complete` (`swiftSettings: [.enableUpcomingFeature(...)]`,
  `swiftLanguageModes: [.v6]`) catches data races, non-Sendable crossings and actor isolation.
  `SWIFT_TREAT_WARNINGS_AS_ERRORS` or `-warnings-as-errors` makes compiler warnings blocking.
  **Periphery** (`.periphery.yml`) finds dead code.

### Python
- **Ruff** (`ruff.toml`, `.ruff.toml`, or `[tool.ruff.lint]` in pyproject.toml): the default `select` is only
  `["E4", "E7", "E9", "F"]`. Look for `select`/`extend-select` (codes or prefixes, `"ALL"`), `ignore`,
  `per-file-ignores`, `extend` (inherited config). Also look for `[tool.ruff.lint.flake8-tidy-imports.banned-api]`, which is config-driven bans.
- **Flake8** (`.flake8`, `setup.cfg [flake8]`, `tox.ini`): `select`, `extend-ignore`. Plugins count only if they are
  installed (requirements files, the pre-commit `additional_dependencies`).
- **Pylint** (`.pylintrc`, `[tool.pylint]`): most checks are on by default. Look for `disable=`, which is usually a long list.
- **mypy** (`mypy.ini`, `[tool.mypy]`, `setup.cfg [mypy]`): `strict = true` includes `disallow_untyped_defs`,
  `disallow_any_generics`, `warn_return_any`, `warn_unused_ignores`, `disallow_untyped_calls` and others.
  It does not include `disallow_any_explicit`. Also check per-module `[[tool.mypy.overrides]]` with `ignore_errors`.
- **pyright / basedpyright** (`pyrightconfig.json`, `[tool.pyright]`): `typeCheckingMode` `basic|standard|strict` plus
  individual `report*` severities.
- **Boundaries**: `import-linter` (`.importlinter`, `[tool.importlinter]`).

### Go
- **golangci-lint** (`.golangci.yml|yaml|toml|json`):
  - v1 defaults: `errcheck, gosimple, govet, ineffassign, staticcheck, unused`.
  - v2 (`version: "2"`): `linters.default: standard` gives the same set, with gosimple and stylecheck merged into staticcheck.
    `default: all` / `none` / `fast` change the base.
  - Then `enable` / `disable` and `linters-settings` (v1) or `linters.settings` (v2).
  - `issues.exclude-rules` (v1) or `linters.exclusions` (v2) can silence a linter per path.
  - `forbidigo` (banned identifiers) and `depguard` (banned imports) are config-driven bans. Read their patterns.
- Also `go vet` alone in CI, and gofmt / goimports / gofumpt (v2 moves these under `formatters:`).

### Rust
- Clippy's default groups are `correctness` (deny), `suspicious`, `style`, `complexity`, `perf` (warn).
  `pedantic`, `nursery`, `restriction` and `cargo` are **off** unless named.
- **Where rules are enabled:**
  - `Cargo.toml` `[lints.clippy]` / `[lints.rust]`, or `[workspace.lints.*]` plus `lints.workspace = true` in each member;
  - crate-root attributes (`#![deny(clippy::unwrap_used)]`, `#![forbid(unsafe_code)]`, `#![warn(clippy::pedantic)]`) in `lib.rs` / `main.rs`;
  - `.cargo/config.toml` `rustflags`;
  - CI flags such as `cargo clippy -- -D warnings -W clippy::...`.
- `clippy.toml` holds **options only** (thresholds, `disallowed-methods`, `disallowed-types`, `allow-unwrap-in-tests`).
  It never enables a lint. The `disallowed_*` lints are on by default but do nothing until their lists are filled.
- Also `rustfmt.toml`, and `cargo-deny` (`deny.toml`) for dependencies and licenses.

### Kotlin
- **ktlint**: configured via `.editorconfig` (`ktlint_code_style`, `ktlint_standard_<rule> = disabled`). It covers formatting and
  style only (wildcard imports, unused imports, naming, spacing).
- **detekt** (`detekt.yml`, `config/detekt/detekt.yml`, the `detekt { config, buildUponDefaultConfig, allRules }` Gradle block):
  every rule has `active: true|false`. With `buildUponDefaultConfig`, unspecified rules keep their defaults.
  Run `detekt --generate-config` (or open the default-detekt-config.yml of the pinned version) to see the defaults.
  Also check `baseline.xml` (existing violations suppressed) and third-party rule sets (Compose rules, formatting).
- **Android Lint** (`lint.xml`, `lint {}` in Gradle, `lint-baseline.xml`).

### Ruby
- **RuboCop** (`.rubocop.yml`):
  - `inherit_from`, `inherit_gem` (for example `rubocop-rails-omakase`), `plugins:` / `require:` (rubocop-rails, -rspec, -performance);
  - `AllCops: NewCops: enable|disable`, `DisabledByDefault: true` (only listed cops run), and per-cop `Enabled`, `Exclude`.
  - **`.rubocop_todo.yml`** excludes files or raises `Max`: those cops are on, but not for the listed files.
  - `standard` / `standardrb` has a fixed config; read the gem's config for what is on.
- **Brakeman** (Rails security), **Sorbet** (`sorbet/config`, `# typed:` sigils), **Steep**, **erb_lint**.

### Cross-cutting runners
- **pre-commit**: `.pre-commit-config.yaml` (hook ids and `args`, `files`/`exclude` regexes), `.husky/*`,
  `lint-staged` (package.json or `.lintstagedrc*`), `lefthook.yml`, `.overcommit.yml`, `simple-git-hooks`.
  These run on staged files only and can be skipped with `--no-verify`, so CI is the stronger signal.
- **CI**: `.github/workflows/*.yml`, `.gitlab-ci.yml`, `.circleci/config.yml`, `bitrise.yml`, `Jenkinsfile`, `azure-pipelines.yml`, `buildkite`.
  Follow indirection (`npm run lint`, `make lint`, `just check`, `./scripts/lint.sh`, `mise run`), and note
  `continue-on-error: true` or `|| true`, which make the job non-blocking.
- **Semgrep** (`.semgrep.yml`, `.semgrep/`, `semgrep --config p/<ruleset>` in CI, `semgrep.dev` app config) and
  **ast-grep** (`sgconfig.yml`, `rules/`): structural patterns with metavariables. Read the local rules and the named registry packs.
- **CodeQL** (`.github/workflows/codeql*.yml`, `.github/codeql/`): security dataflow (injection, XSS, path traversal).
  **SonarQube / SonarCloud** (`sonar-project.properties`): quality profile lives server-side, so ask.
- **Danger** (`Dangerfile`, `Dangerfile.swift`, `dangerfile.{js,ts}`) runs PR-level checks: diff size, changelog, tests
  touched, regexes over `git.diff`. A regex warning there already covers that literal pattern.

---

## 2. Rule ideas that are already covered

If the repo enables the rule and CI runs it, drop the candidate. If the rule is available but not enabled, see section 3.

### TypeScript / JavaScript / React
| Candidate rule idea | Deterministic rule | On? |
|---|---|---|
| No explicit `any` | `@typescript-eslint/no-explicit-any`; Biome `suspicious/noExplicitAny`; tsc `noImplicitAny` for implicit | D (ts recommended) |
| Unsafe use of `any` values | `@typescript-eslint/no-unsafe-assignment`, `-member-access`, `-call`, `-return`, `-argument` | D in recommendedTypeChecked, T |
| Promise not awaited / floating | `@typescript-eslint/no-floating-promises` | D in recommendedTypeChecked, T |
| Async fn passed where void callback expected | `@typescript-eslint/no-misused-promises` | D in recommendedTypeChecked, T |
| `await` on non-promise | `@typescript-eslint/await-thenable` | D in recommendedTypeChecked, T |
| Non-null assertion `x!` | `@typescript-eslint/no-non-null-assertion`; Biome `style/noNonNullAssertion` | D in ts strict; O otherwise |
| `@ts-ignore` / `@ts-expect-error` without reason | `@typescript-eslint/ban-ts-comment` | D |
| Unused vars / imports | `no-unused-vars` / `@typescript-eslint/no-unused-vars`; tsc `noUnusedLocals` | D |
| Switch not exhaustive over a union | `@typescript-eslint/switch-exhaustiveness-check` | O, T |
| Always-truthy / redundant condition | `@typescript-eslint/no-unnecessary-condition` | D in strictTypeChecked, T |
| Use `??` instead of `\|\|` | `@typescript-eslint/prefer-nullish-coalescing` | D in stylisticTypeChecked, T |
| Throwing non-Error values | `@typescript-eslint/only-throw-error` (T, recommendedTypeChecked in v8); core `no-throw-literal` (O) | D / O |
| Type-only imports | `@typescript-eslint/consistent-type-imports`; tsc `verbatimModuleSyntax` | O |
| Explicit return types | `@typescript-eslint/explicit-function-return-type`, `explicit-module-boundary-types` | O |
| Indexing may be undefined | tsc `noUncheckedIndexedAccess` | O (not in strict) |
| `console.log` left in | `no-console`; Biome `suspicious/noConsole` | O |
| `debugger` left in | `no-debugger` | D |
| `==` instead of `===` | `eqeqeq`; Biome `suspicious/noDoubleEquals` | O (ESLint), D (Biome) |
| `var`, `let` never reassigned | `no-var`, `prefer-const` | O in core; on via typescript-eslint's `eslint-recommended` |
| Empty catch / block | `no-empty` | D |
| `eval` / implied eval | `no-eval` (O), `@typescript-eslint/no-implied-eval` (D in recommendedTypeChecked, T) | |
| Nested ternaries, complexity, depth, params, function length | `no-nested-ternary`, `complexity`, `max-depth`, `max-params`, `max-lines-per-function` | O |
| `await` inside loops | `no-await-in-loop` | O |
| Banned API / import (team-specific) | `no-restricted-imports`, `no-restricted-syntax`, `no-restricted-globals` | O (config-driven) |
| Hook called conditionally | `react-hooks/rules-of-hooks` | D |
| Missing / extra effect deps | `react-hooks/exhaustive-deps`; Biome `correctness/useExhaustiveDependencies` | D |
| setState synchronously in effect; impure render; ref read in render | eslint-plugin-react-hooks v6+/v7 compiler rules (`set-state-in-effect`, `purity`, `refs`, ...) | D in recent recommended; check version |
| Missing `key` in list | `react/jsx-key` | D (react recommended) |
| Array index as key | `react/no-array-index-key` | O |
| `dangerouslySetInnerHTML` | `react/no-danger` | O |
| Component defined inside component | `react/no-unstable-nested-components` | O |
| Missing `alt`, click without keyboard, invalid anchor, unlabeled control | `jsx-a11y/alt-text`, `click-events-have-key-events`, `anchor-is-valid`, `label-has-associated-control` | D (a11y recommended) |
| `<img>` in Next.js | `@next/next/no-img-element` | D (next config) |
| Import cycles | `import/no-cycle` | O (slow) |
| Default exports banned | `import/no-default-export` | O |
| Undeclared dependency imported | `import/no-extraneous-dependencies` | O |
| `node:` protocol, `forEach`, `null`, abbreviations, file naming | `unicorn/prefer-node-protocol`, `no-array-for-each`, `no-null`, `prevent-abbreviations`, `filename-case` | D (unicorn recommended) |
| Import from a forbidden layer | dependency-cruiser, `import/no-restricted-paths`, eslint-plugin-boundaries | O (config-driven) |

### Swift
| Candidate rule idea | Deterministic rule | On? |
|---|---|---|
| Force cast `as!` | SwiftLint `force_cast` | D |
| Force try `try!` | SwiftLint `force_try`; swift-format `NeverUseForceTry` (O) | D |
| Force unwrap `x!` | SwiftLint `force_unwrapping`; swift-format `NeverForceUnwrap` | O |
| Implicitly unwrapped optionals | SwiftLint `implicitly_unwrapped_optional`; swift-format `NeverUseImplicitlyUnwrappedOptionals` | O |
| Long functions / types / files, deep nesting, complexity | `function_body_length`, `type_body_length`, `file_length`, `nesting`, `cyclomatic_complexity` | D |
| Naming | `identifier_name`, `type_name` | D |
| TODO / FIXME comments | `todo` | D |
| `fatalError` without message | `fatal_error_message` | O |
| `@State` not private | `private_swiftui_state` | O |
| `Task {}` with throwing body, error dropped | `unhandled_throwing_task` | O |
| `async` function that never awaits | `async_without_await` | O |
| `.count == 0` instead of `isEmpty` | `empty_count` | O |
| `filter{}.first` | `first_where` | O |
| Image / button accessibility | `accessibility_label_for_image`, `accessibility_trait_for_button` | O |
| `print` / `NSLog` banned | `custom_rules` regex (no built-in) | O (config-driven) |
| Unused imports / declarations | `unused_import`, `unused_declaration` (analyzer only); Periphery | O |
| Data races, non-Sendable across actors, isolation | Swift 6 compiler / strict concurrency | build setting |

### Python
| Candidate rule idea | Deterministic rule | On? |
|---|---|---|
| Bare `except:` | Ruff/pycodestyle `E722`; Pylint `bare-except` | D (Ruff E7) |
| `except Exception` swallowing | Ruff `BLE001`; Pylint `broad-exception-caught` | O (Ruff), D (Pylint) |
| `raise` in except without `from` | Ruff `B904` | O |
| `print` debugging | Ruff `T201` (`T203` pprint) | O |
| Commented-out code | Ruff `ERA001` | O |
| Mutable default argument | Ruff `B006`; Pylint `dangerous-default-value` | O (Ruff), D (Pylint) |
| Call in default argument | Ruff `B008` | O |
| Unused imports / variables | Ruff `F401`, `F841` | D |
| Missing type annotations | Ruff `ANN001`, `ANN201`...; mypy `disallow_untyped_defs` | O |
| `Any` in annotations | Ruff `ANN401`; mypy `disallow_any_explicit` | O |
| Blanket `# type: ignore` | Ruff `PGH003`; mypy `warn_unused_ignores` | O |
| Naive `datetime.now()` | Ruff `DTZ005` (DTZ family) | O |
| f-string in logging call | Ruff `G004` | O |
| `requests` without timeout | Ruff `S113` | O |
| `assert` in prod code, hardcoded passwords, SQL string building, `subprocess` with shell, `pickle` / `eval` | Ruff `S101`, `S105`, `S608`, `S602`, `S301`, `S307` (Bandit) | O |
| `asyncio.create_task` result not stored | Ruff `RUF006` | O |
| Magic numbers | Ruff `PLR2004` | O |
| Too many args / branches, complexity | Ruff `PLR0913`, `PLR0912`, `C901`; Pylint `too-many-*` | O (Ruff), D (Pylint) |
| Use pathlib | Ruff `PTH` family | O |
| Docstrings missing | Ruff `D` family; Pylint `missing-*-docstring` | O (Ruff), D (Pylint) |
| Banned module / API | Ruff `TID251` banned-api; import-linter | O (config-driven) |
| Optional accessed without None check | mypy / pyright strict optional | D in both |

### Go
| Candidate rule idea | Deterministic rule | On? |
|---|---|---|
| Ignored error return | `errcheck` | D |
| Value assigned but never used | `ineffassign`, staticcheck `SA4006` | D |
| Unused code | `unused` | D |
| Printf format mismatch, copied mutex, lost context cancel | `govet` (`printf`, `copylocks`, `lostcancel`) | D |
| Deprecated API use | staticcheck `SA1019` | D |
| `err == ErrX` instead of `errors.Is`; `%v` instead of `%w` | `errorlint` | O |
| Errors from external packages not wrapped | `wrapcheck` | O |
| HTTP body not closed | `bodyclose` | O |
| `sql.Rows` errors / close | `rowserrcheck`, `sqlclosecheck` | O |
| HTTP request without context | `noctx` | O |
| Non-exhaustive enum switch | `exhaustive` | O |
| Security (weak crypto, SQL string concat, unhandled errors) | `gosec` | O |
| Complexity, length, nesting | `gocyclo`, `gocognit`, `funlen`, `nestif` | O |
| Magic numbers, repeated strings | `mnd`, `goconst` | O |
| `fmt.Println` / banned identifiers | `forbidigo` | O (config-driven) |
| Banned imports / layer rules | `depguard` | O (config-driven) |
| `return nil, nil` / nil error with nil value | `nilnil`, `nilerr` | O |
| Unchecked type assertion | `forcetypeassert` | O |
| Globals, `init()` | `gochecknoglobals`, `gochecknoinits` | O |
| `//nolint` without reason | `nolintlint` | O |

### Rust
| Candidate rule idea | Deterministic rule | On? |
|---|---|---|
| `.unwrap()` | `clippy::unwrap_used` | O (restriction) |
| `.expect()` | `clippy::expect_used` | O (restriction) |
| `panic!`, `todo!`, `unimplemented!` | `clippy::panic`, `clippy::todo`, `clippy::unimplemented` | O (restriction) |
| `dbg!`, `println!` left in | `clippy::dbg_macro`, `clippy::print_stdout`, `clippy::print_stderr` | O (restriction) |
| Indexing may panic | `clippy::indexing_slicing` | O (restriction) |
| Lossy `as` casts | `clippy::as_conversions` (restriction), `clippy::cast_possible_truncation` (pedantic) | O |
| Ignored `Result` / `#[must_use]` value | rustc `unused_must_use` | D |
| Lock held across `.await` | `clippy::await_holding_lock` | D (suspicious) |
| `unsafe` code | rustc `unsafe_code` (`#![forbid(unsafe_code)]`) | O |
| `unsafe` block without SAFETY comment | `clippy::undocumented_unsafe_blocks` | O (restriction) |
| Missing docs / `# Errors` / `# Panics` | rustc `missing_docs`; `clippy::missing_errors_doc`, `missing_panics_doc` | O (pedantic) |
| Too many arguments | `clippy::too_many_arguments` | D (complexity) |
| Function too long | `clippy::too_many_lines` | O (pedantic) |
| Wildcard match on enum | `clippy::wildcard_enum_match_arm` | O (restriction) |
| Banned method / type | `clippy::disallowed_methods`, `disallowed_types` + `clippy.toml` lists | D but empty until configured |

### Kotlin (detekt unless noted; check `active:` in the pinned default config)
| Candidate rule idea | Deterministic rule | On? |
|---|---|---|
| `!!` operator | `UnsafeCallOnNullableType` | check |
| Unsafe `as` cast | `UnsafeCast` | check |
| Empty catch | `EmptyCatchBlock` | D |
| Catching `Exception` / `Throwable` | `TooGenericExceptionCaught` | D |
| Swallowed exception | `SwallowedException` | check |
| `printStackTrace()` | `PrintStackTrace` | check |
| Magic numbers | `MagicNumber` | D |
| Long method / parameter list, complexity, nesting | `LongMethod`, `LongParameterList`, `CyclomaticComplexMethod`, `NestedBlockDepth` | D |
| TODO / FIXME comments | `ForbiddenComment` | D |
| `GlobalScope` | `GlobalCoroutineUsage` | O |
| `Thread.sleep` in coroutines | `SleepInsteadOfDelay` | check |
| Hardcoded `Dispatchers.IO` | `InjectDispatcher` | check |
| `lateinit` | `LateinitUsage` | O |
| Banned calls | `ForbiddenMethodCall`, `ForbiddenImport` | O (config-driven) |
| Wildcard / unused imports | ktlint `no-wildcard-imports`, `no-unused-imports`; detekt `WildcardImport` | D (ktlint standard) |
| Hardcoded UI strings (Android) | Android Lint `HardcodedText` | D |

### Ruby (RuboCop unless noted)
| Candidate rule idea | Deterministic rule | On? |
|---|---|---|
| `binding.pry` / `byebug` / `debugger` left in | `Lint/Debugger` | D |
| Empty `rescue` | `Lint/SuppressedException` | D |
| `rescue Exception` | `Lint/RescueException` | D |
| Bare `rescue` style | `Style/RescueStandardError` | D |
| `eval`, `JSON.load`, `YAML.load`, `Kernel#open` | `Security/Eval`, `Security/JSONLoad`, `Security/YAMLLoad`, `Security/Open` | D |
| Long methods / classes, ABC size | `Metrics/MethodLength`, `Metrics/ClassLength`, `Metrics/AbcSize` | D |
| `puts` / `print` in app code | `Rails/Output` | D (rubocop-rails) |
| `update_column`, `update_all` skipping validations | `Rails/SkipsModelValidations` | D (rubocop-rails) |
| `Time.now` instead of `Time.current` | `Rails/TimeZone` | D (rubocop-rails) |
| `has_many` without `dependent:` | `Rails/HasManyOrHasOneDependent` | D (rubocop-rails) |
| Frozen string literal comment | `Style/FrozenStringLiteralComment` | D |
| Class documentation | `Style/Documentation` | D (often disabled) |
| SQL injection, mass assignment, unsafe redirects | Brakeman | if run in CI |
| Missing type signatures | Sorbet `# typed: strict` | per-file sigil |

---

## 3. Deciding: covered, config change, ask, or Jev

1. **Covered: drop it.** The rule is enabled for the files in question (by preset or explicitly, not
   excluded by path, ignore or baseline), **and** a blocking CI job or pre-commit hook runs it. Record it in
   `.jev-lint/README.md` as "dropped: covered by <tool> <rule>".
2. **Available but off: ask, don't propose.** The linter is set up but this rule is disabled, listed in
   `disabled_rules` / `ignore` / `disable`, set to `"off"`, or sits in a todo or baseline file. The team may have turned it off on purpose.
   Put it in the README as a question ("`force_unwrapping` is disabled in .swiftlint.yml; intended?").
   Never re-create a disabled rule as a Jev rule.
3. **Expressible but not configured: propose a linter config change instead.** The repo's linter can
   express the check (an existing rule, `no-restricted-syntax`, a SwiftLint `custom_rules` regex, Ruff `TID251`,
   `forbidigo`, `depguard`, `clippy.toml` `disallowed-methods`, detekt `ForbiddenMethodCall`, a Semgrep or ast-grep rule).
   A config change is exact, free per edit, and works in CI. List it under "suggested linter changes" in the README.
4. **Tool present, not enforced.** The linter is configured but nothing runs it, or it runs with
   `continue-on-error` / `|| true` / without `--strict`. Say so, and still prefer fixing enforcement over a Jev rule.
5. **Type-aware or analyzer-only rules** (T rows, `swiftlint analyze`, full `tsc` in a bundler-only repo) count
   only if that mode actually runs in CI.
6. **Only literal patterns count as covered.** A literal pattern (`print(`, `x!`, `.unwrap()`) is covered by a
   rule matching it. A *judgement* about the same code ("this `!` is unsafe **because** the value comes from
   the network") is not covered, and may be a Jev rule. Write that rule's `false` criteria so it defers to
   the linter on the literal part.
7. **When unsure, probe** (section 1) before deciding. Record the probe command and its output in the README.

---

## 4. What Jev adds that linters cannot

**Rule of thumb:** if you can write the check as an AST pattern or a regex, without knowing what the code
*means*, it belongs in a deterministic tool. Jev is for checks where naming the pattern needs intent,
semantics or a team convention, and where the evidence is still visible in the added snippet.

- **Intent vs. mechanism.** An effect that only derives state from props or other state; a `useMemo` or
  cache that stores what could be computed; a retry wrapped around a non-idempotent call.
- **Trust boundaries.** Data from `fetch`, `JSONDecoder`, `json.loads`, request bodies or env vars used as a
  typed value without validation (Zod, Codable checks, pydantic); user input reaching a query, shell or path.
- **Protocol and lifetime misuse a type system doesn't encode.** A continuation resumed twice or on
  some paths not at all; a subscription or observer added without a matching teardown; a `Task` not cancelled on view exit.
- **Ownership and architecture read from the code itself.** A SwiftUI view that owns state it should
  receive; a view or route handler doing persistence or network work the repo's guidelines put in a service layer.
- **Business-rule conventions.** Money as float instead of the repo's `Money`/decimal type; timestamps
  formatted for display outside the formatter module; feature-flag checks bypassing the flag helper;
  PII written to logs. This applies only when the guideline says so and a literal ban can't express it.
- **Error-handling quality.** An error caught and replaced with a default that hides a failure the caller
  needs; a user-facing error message that leaks internals. The *catch shape* is the linter's job; the *consequence* is Jev's.
- **Naming and comments that contradict the code.** A function named `validateX` that also mutates; a
  comment describing behaviour the code doesn't have.

Keep the section 2 constraints from SKILL.md: visible in `added_code` alone, one concrete pattern, no counting or tracing.
