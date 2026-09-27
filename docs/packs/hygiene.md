# Hygiene pack

Small code-hygiene rules: the things a careful reviewer flags in any language.

Each rule shows code the check flags (**bad**), similar code it leaves alone (**good**), and why. The examples are real cases from the eval set. _Candidate_ rules are still being evaluated and are not asked by the hook yet.

## Swift

### `swift-no-force-unwrap`

Does the new code force-unwrap an optional with a postfix `!`, such as `user!.name`, `URL(string: s)!`, or `dict[key]!`?

**Catches:** A postfix `!` force-unwraps an optional value.

**Fix:** Use `guard let`, `if let`, `??`, or throw a descriptive error.

**Bad** (`ProfileHeaderView.swift`):

```swift
func configure(with user: User?) {
        nameLabel.text = user!.displayName
        avatarView.setInitials(from: user!.displayName)
    }
```

**Not flagged:** No force unwraps. Logical not (`!flag`), `!=`, `try!`, `as!`, and implicitly unwrapped declarations like `var label: UILabel!` do not count.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-force-try`

Does the new code use `try!`?

**Catches:** The added code contains `try!`.

**Fix:** Use `do/catch` or propagate with `throws`.

**Bad** (`BlobStore.swift`):

```swift
init(rootURL: URL) {
        self.rootURL = rootURL
        try! FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
    }

    func remove(key: String) throws {
        try FileManager.default.removeItem(at: fileURL(for: key))
    }
```

**Not flagged:** The added code uses `try`, `try?`, or no try at all.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-force-cast`

Does the new code use a forced cast `as!`?

**Catches:** The added code contains `as!`.

**Fix:** Use `as?` with `guard let` and handle the failure.

**Bad** (`UserPayloadParser.swift`):

```swift
let userDictionary = try JSONSerialization.jsonObject(with: responseBytes) as! [String: Any]

        return User(dictionary: userDictionary)
```

**Not flagged:** Casts use `as?` or `as`, or there are no casts.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-debug-print`

Does the new code add a `print(...)`, `debugPrint(...)`, or `dump(...)` call that looks like leftover debugging output?

**Catches:** There is a print/debugPrint/dump call printing values for debugging, e.g. `print("got here", response)`.

**Fix:** Remove it or use `Logger` from `os`.

**Bad** (`SearchViewModel.swift`):

```swift
@Published var state: LoadState = .idle {
        didSet {
            print("state changed to \(state)")
        }
    }
```

**Not flagged:** No debug prints. Output in a command-line tool's intended user-facing path, or logging via `Logger`/`os_log`, does not count.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-empty-catch`

Does the new code contain a `catch` block that silently swallows the error, doing nothing or only containing a comment?

**Catches:** A catch block is empty or has only comments.

**Fix:** Log, rethrow, or surface the error.

**Bad** (`SessionController.swift`):

```swift
do { try keychain.delete(account: account) } catch { /* not important */ }

        session = nil
        tokenRefreshTask?.cancel()
```

**Not flagged:** Every catch block logs, rethrows, returns, or otherwise handles the error, or there is no catch.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-restating-comment`

Does the new code contain a comment that merely restates what the next line of code obviously does, adding no information (e.g. `// set the title` above `title = "Home"`)?

**Catches:** At least one comment just narrates the code in plain words without explaining why or adding context.

**Fix:** Delete comments that narrate the code; keep only ones that explain why.

**Bad** (`HomeViewController.swift`):

```swift
super.viewDidLoad()
        // set the title
        title = "Home"
```

**Not flagged:** Comments explain intent, reasons, constraints, or non-obvious behavior, or there are no comments.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-vague-names`

Does the new code declare a variable, constant, parameter, or function with a vague or meaningless name such as `data`, `temp`, `tmp`, `foo`, `thing`, `stuff`, `x`, `val2`, or `obj`, outside of short loop indices or conventional names like `i`, `error`, `id`, `vc`?

**Catches:** A newly declared name gives no clue what it holds.

**Fix:** Rename to say what the value is.

**Bad** (`PriceCalculator.swift`):

```swift
let x = subtotal * taxRate

        let val2 = subtotal + x
        return val2.rounded(scale: currencyScale)
```

**Not flagged:** All newly declared names are descriptive or conventional.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `swift-no-magic-numbers`

Does the new code use an unexplained numeric literal in logic (like `if retries > 7`, `asyncAfter(deadline: .now() + 86400)`, or `price * 0.0825`) instead of a named constant, excluding 0, 1, -1, 2 and numbers that are obvious from context?

**Catches:** A bare number with non-obvious meaning appears in logic.

**Fix:** Extract the number into a well-named constant.

**Bad** (`UploadQueue.swift`):

```swift
retries += 1
        if retries > 7 {
            throw UploadError.gaveUp
        }
```

**Not flagged:** Numbers are named constants, trivial values, layout padding in SwiftUI modifiers, or self-explanatory in context.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-commented-out-code`

Does the new code contain commented-out code, meaning lines of Swift source disabled by putting them in comments?

**Catches:** A comment contains code that was disabled, e.g. `// let old = compute(x)`.

**Fix:** Delete dead code; version control keeps history.

**Bad** (`LibraryViewController.swift`):

```swift
/*
        if user.isPremium {
            showUpgradeBanner()
        }
        */
        refreshControl?.endRefreshing()
```

**Not flagged:** Comments are prose only; code examples in documentation comments do not count.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-bare-todo`

Does the new code add a TODO, FIXME, or XXX comment without an issue link, ticket number, or owner?

**Catches:** A TODO/FIXME/XXX comment has no ticket reference (like #123, ABC-45, a URL) or owner name.

**Fix:** Either do it now or reference a tracked issue.

**Bad** (`OrdersViewModel.swift`):

```swift
func loadOrders() async throws {
        // TODO: handle pagination
        orders = try await api.orders(page: 1)
    }
```

**Not flagged:** No TODO-style comments, or each one references a ticket, URL, or owner.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-no-hardcoded-secret`

Does the new code hardcode a real-looking secret such as an API key, password, access token, or private key as a literal string?

**Catches:** A credential-like literal value is embedded, e.g. `let apiKey = "sk_live_51H..."`.

**Fix:** Load the secret from the Keychain or build configuration.

**Bad** (`OAuthConfiguration.swift`):

```swift
static let clientID = "shop-ios-app"
    static let clientSecret = "c9b2e4f7a1d64e0b8f3a5c7d9e1f2a4b6c8d0e2f"

            URLQueryItem(name: "client_id", value: Self.clientID),
            URLQueryItem(name: "client_secret", value: Self.clientSecret),
```

**Not flagged:** Secrets come from the Keychain, configuration, or environment; placeholders like `"<YOUR_KEY>"` or empty strings do not count.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `swift-ui-off-main`

Does the new code update UI state (a UIKit view or label, or a SwiftUI `@State`/`@Published` property) inside a background context such as `DispatchQueue.global().async` or a URLSession completion handler, without hopping back to the main thread?

**Catches:** UI or view state is mutated from a background queue or callback with no `DispatchQueue.main`, `MainActor.run`, or `@MainActor` hop.

**Fix:** Wrap the UI update in `await MainActor.run { }` or `DispatchQueue.main.async { }`, or mark the type `@MainActor`.

**Bad** (`NewsFeedModel.swift`):

```swift
func reload() {
        URLSession.shared.dataTask(with: Endpoint.headlines.url) { responseBytes, _, _ in
            guard let responseBytes,
                  let decodedHeadlines = try? JSONDecoder().decode([Headline].self, from: responseBytes) else { return }
            self.headlines = decodedHeadlines
        }.resume()
    }
```

**Not flagged:** UI updates happen on the main thread or main actor, or the code does not touch UI state from background work.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `swift-prefer-guard`

Does the new code contain a pyramid of three or more nested `if let` / `if` statements where `guard` with early exit would flatten it?

**Catches:** Nested optional-binding or conditional checks create deep indentation that `guard` could flatten.

**Fix:** Use `guard let ... else { return }` for preconditions.

**Bad** (`ShippingLabelFormatter.swift`):

```swift
func shippingLabel(for order: Order) -> String? {
        if let customer = order.customer {
            if let address = customer.shippingAddress {
                if let postalCode = address.postalCode {
                    return "\(customer.fullName)\n\(address.street)\n\(address.city) \(postalCode)"
                }
            }
        }
        return nil
    }
```

**Not flagged:** Uses `guard` for early exits, or nesting is shallow.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

## Typescript

### `ts-no-explicit-any`

Does the new code use the TypeScript type `any`, such as a `: any` annotation, `as any`, `any[]`, or `<any>`?

**Catches:** The added code writes the `any` type somewhere.

**Fix:** Replace `any` with a precise type or `unknown` plus narrowing.

**Bad** (`billing.ts`):

```ts
} catch (err: any) {
    logger.error("invoice sync failed", { message: err.message, invoiceId });
    throw err;
  }
```

**Not flagged:** The added code never writes the `any` type. The word `any` inside a string, comment, or a name like `anyMatch` does not count, and `unknown` is fine.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `ts-no-non-null-assertion`

Does the new code use the TypeScript non-null assertion operator, a `!` placed directly after an expression such as `user!.name`, `map.get(k)!`, or `el!`?

**Catches:** A postfix `!` asserts that a value is not null or undefined.

**Fix:** Handle the null/undefined case explicitly (guard, optional chaining, or a thrown error with context).

**Bad** (`SearchBox.tsx`):

```ts
const inputRef = useRef<HTMLInputElement>(null);

  const openSearch = () => {
    setOpen(true);
    inputRef.current!.focus();
  };
```

**Not flagged:** No postfix non-null `!`. Logical not (`!x`), `!=`, `!==`, and definite assignment on class fields do not count.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `ts-no-empty-catch`

Does the new code contain a catch block (or `.catch` handler) that silently swallows the error, doing nothing or only containing a comment?

**Catches:** A catch or .catch handler is empty or only has comments, so the error disappears.

**Fix:** Log, rethrow, or convert the error into a handled result; never swallow it silently.

**Bad** (`register.ts`):

```ts
navigator.serviceWorker.register("/sw.js").catch(() => {
  /* offline support is optional */
});

export const SW_ENABLED = import.meta.env.PROD;
```

**Not flagged:** Every catch handler logs, rethrows, returns an error value, or otherwise handles the error, or there is no catch at all.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `ts-no-debug-console`

Does the new code add a `console.log`, `console.debug`, or `console.dir` call that looks like leftover debugging output?

**Catches:** There is a console.log/debug/dir call printing values for debugging, e.g. `console.log('here', data)`.

**Fix:** Remove debug logging or use the project's logger.

**Bad** (`CheckoutForm.tsx`):

```ts
const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    console.log("submitting", cart, shippingAddress);
```

**Not flagged:** No debug console calls. `console.error`/`console.warn` for real error reporting, or output in a CLI program's main user-facing path, does not count.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `ts-no-restating-comment`

Does the new code contain a comment that merely restates what the next line of code obviously does, adding no information (e.g. `// increment i` above `i++`)?

**Catches:** At least one comment just narrates the code in plain words without explaining why or adding context.

**Fix:** Delete comments that narrate the code; keep only ones that explain why.

**Bad** (`guards.ts`):

```ts
// check if user is admin
  if (user.role !== "admin") {
    throw new ForbiddenError("Admin access required");
  }
```

**Not flagged:** Comments explain intent, reasons, constraints, or non-obvious behavior, or there are no comments.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `ts-no-vague-names`

Does the new code declare a variable, parameter, or function with a vague or meaningless name such as `data`, `temp`, `tmp`, `foo`, `thing`, `stuff`, `x`, `val2`, or `obj`, outside of short loop indices or conventional names like `i`, `e`, `err`, `id`, `req`, `res`?

**Catches:** A newly declared name gives no clue what it holds.

**Fix:** Rename to say what the value is.

**Bad** (`categoryOptions.ts`):

```ts
export function toOptions(categories: Category[]): SelectOption[] {
  return categories.map((thing) => ({ label: thing.name, value: thing.slug }));
}
```

**Not flagged:** All newly declared names are descriptive or conventional.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `ts-no-magic-numbers`

Does the new code use an unexplained numeric literal in logic (like `if (retries > 7)`, `setTimeout(fn, 86400000)`, or `price * 0.0825`) instead of a named constant, excluding 0, 1, -1, 2 and numbers that are obvious from context?

**Catches:** A bare number with non-obvious meaning appears in logic.

**Fix:** Extract the number into a well-named constant.

**Bad** (`search.ts`):

```ts
if (query.length < 3) {
    return [];
  }
  const products = await productIndex.search(query, { limit: 25 });
```

**Not flagged:** Numbers are named constants, trivial values, or self-explanatory in context (array index 0, HTTP status 404, percent 100).

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `ts-no-commented-out-code`

Does the new code contain commented-out code, meaning lines of source code disabled by putting them in comments?

**Catches:** A comment contains code that was disabled, e.g. `// const old = compute(x);`.

**Fix:** Delete dead code; version control keeps history.

**Bad** (`sort.ts`):

```ts
const newestFirst = [...orders].sort(byCreatedAtDesc);
  // console.log(newestFirst);
  return newestFirst;
```

**Not flagged:** Comments are prose only; code examples inside doc comments (JSDoc @example) do not count.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `ts-no-bare-todo`

Does the new code add a TODO, FIXME, or XXX comment without an issue link, ticket number, or owner?

**Catches:** A TODO/FIXME/XXX comment has no ticket reference (like #123, ABC-45, a URL) or owner name.

**Fix:** Either do it now or reference a tracked issue.

**Bad** (`auth.ts`):

```ts
// XXX temporary hack until the new auth service ships
  if (request.headers.get("x-internal") === "true") {
    return next();
  }
```

**Not flagged:** No TODO-style comments, or each one references a ticket, URL, or owner.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `ts-no-hardcoded-secret`

Does the new code hardcode a real-looking secret such as an API key, password, access token, or private key as a literal string?

**Catches:** A credential-like literal value is embedded, e.g. `const apiKey = "sk_live_51H..."` or `password: "hunter2"`.

**Fix:** Load the secret from the environment or a secret manager.

**Bad** (`redis.ts`):

```ts
import Redis from "ioredis";

export const redis = new Redis("redis://default:q8Vn2LpX7rT4wZ1k@cache-prod.acme.internal:6379");
```

**Not flagged:** Secrets come from environment variables, config, or a secret store; placeholders like `"<YOUR_KEY>"` or empty strings do not count.

Holdout: precision 100%, recall 100% (4 violations in the holdout set).

### `ts-no-ts-ignore`

Does the new code add a `@ts-ignore` or `@ts-nocheck` comment, or a `@ts-expect-error` comment with no explanation after it?

**Catches:** A TypeScript suppression directive silences the type checker without a stated reason.

**Fix:** Fix the type error; if suppression is unavoidable use `@ts-expect-error` with a reason.

**Bad** (`vite.config.ts`):

```ts
// @ts-nocheck
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  plugins: [react(), legacy({ targets: ["defaults", "not IE 11"] })],
});
```

**Not flagged:** No suppression directives, or a `@ts-expect-error` followed by an explanation.

Holdout: precision 100%, recall 100% (3 violations in the holdout set).
