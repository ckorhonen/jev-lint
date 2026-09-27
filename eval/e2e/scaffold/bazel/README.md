# storefront

Bazel monorepo (bzlmod, `rules_python`). `bazel test //...` runs every test.

- `pricing/` — price calculation library (`:pricing`) and its unit test (`:pricing_test`)
- `tools/` — Starlark macros and rules shared across packages (`tools/defs.bzl`)

Packages default to private visibility; other teams' packages list what they may depend on.
