# Performance pack

Snippet-visible performance problems: queries or writes per item in a loop (N+1), sync I/O on request paths, unbounded queries, independent calls awaited one by one, and the opposite mistake, unbounded fan-out with no concurrency limit.

Each rule shows code the check flags (**bad**), similar code it leaves alone (**good**), and why. The examples are real cases from the eval set. _Candidate_ rules are still being evaluated and are not asked by the hook yet.

## Kotlin

### `kt-perf-sequential-suspend-calls`

Does the new code call independent suspend functions one after another — a `for`/`map` loop calling `api.fetch(item)` per item of a variable-length collection inside a coroutine, or two or more consecutive suspend calls whose arguments don't depend on each other's results — where `coroutineScope { items.map { async { … } }.awaitAll() }` could run them concurrently? A loop over a literal list of two or three values with a comment saying serial is intended does not count.

**Catches:** Independent suspend calls run serially when they could run concurrently.

**Fix:** Run the independent calls concurrently with `async { }` + `awaitAll()` inside `coroutineScope`, bounded if the list can be large.

**Bad** (`OrderSummaryService.kt`):

```kotlin
suspend fun summary(id: String): OrderSummary {
        val order = orders.find(id)
        val tracking = shipping.trackingFor(id)
        val review = reviews.forOrder(id)
        return OrderSummary(order, tracking, review)
    }
```

**Good** (`SeedDataLoader.kt`, looks similar but is fine):

```kotlin
package com.acme.onboarding

class SeedDataLoader(private val api: ContentApi, private val store: ContentStore) {
    // Exactly two fixed locales ship in v1; serial is fine and keeps logs readable.
    suspend fun preload() {
        for (locale in listOf("en", "de")) {
            store.save(locale, api.fetchStrings(locale))
        }
    }
}
```

**Not flagged:** Each call needs the previous result; order matters (sequential writes, a rate limit with a comment); calls already use `async`/`awaitAll` or a Flow operator like `flatMapMerge`; or the loop has a small fixed bound with a comment.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

## Python

### `py-perf-orm-query-in-loop`

Does the new code loop over ORM records (a Django QuerySet or SQLAlchemy result) and, inside the loop or comprehension, touch a related object or run another query per record -- `order.customer.name`, `post.comments.all()`, `post.comments.count()`, `Model.objects.get(...)`, `Model.objects.filter(...)`, `session.get(...)`, `session.execute(select(...))` -- without `select_related`, `prefetch_related`, `joinedload`, `selectinload`, an annotation, or a single bulk query before the loop?

**Catches:** Each iteration triggers another database query (N+1).

**Why it matters:** CodeRabbit reports N+1 and excessive I/O ~8x more often in AI PRs.

**Fix:** Load related data before the loop (select_related/prefetch_related in Django, joinedload/selectinload in SQLAlchemy) or fetch everything with one `__in` query.

**Bad** (`views.py`):

```python
def feed(request):
    posts = Post.objects.filter(published=True).order_by("-published_at")[:30]
    data = [
        {"title": p.title, "author": p.author.display_name, "comments": [c.body for c in p.comments.all()]}
        for p in posts
    ]
    return JsonResponse({"posts": data})
```

**Good** (`exports.py`, looks similar but is fine):

```python
import csv


def export_entries(entries, out):
    writer = csv.writer(out)
    writer.writerow(["id", "headline", "blog_id", "pub_date"])
    for entry in entries:
        writer.writerow([entry.id, entry.headline, entry.blog_id, entry.pub_date.isoformat()])
```

**Not flagged:** Related data is loaded up front (`select_related`, `prefetch_related`, `joinedload`, `selectinload`, `annotate(Count(...))`, an `__in`/`.in_()` bulk fetch into a dict); the loop only reads the record's own columns or a foreign-key id (`entry.blog_id`); the loop is over a small fixed list; or the loop is not over database records. Saving, creating or deleting one record per iteration is a write, which belongs to py-perf-orm-write-in-loop, not this rule.

Holdout: precision 100%, recall 100% (6 violations in the holdout set). Sources: [docs.djangoproject.com](https://docs.djangoproject.com/en/5.2/topics/db/optimization/)

### `py-perf-orm-write-in-loop`

Does the new code write to the database once per item inside a loop over a variable-length collection (a queryset, a function argument, a fetched list) -- calling `.save()`, `Model.objects.create(...)`, `.delete()`, or `session.add(obj)` followed by `session.commit()`/`session.flush()` on every iteration -- where a bulk operation (`bulk_create`, `bulk_update`, `QuerySet.update()`/`.delete()`, `session.add_all()` plus one commit, `insert().values([...])`, `executemany`) would do it in one or a few statements? Does not count: a loop over a literal tuple or list of a few values written in the code (`for code in ("EUR", "USD", "GBP"):`), or a loop with a comment explaining that each row must go through `save()` (signals, `save()` overrides).

**Catches:** The loop issues one write (and often one commit) per item.

**Why it matters:** excessive I/O is the top AI performance finding in the CodeRabbit study.

**Fix:** Use `bulk_create`/`bulk_update`/`QuerySet.update()` (Django) or `add_all` plus one commit / `insert().values([...])` (SQLAlchemy).

**Bad** (`services.py`):

```python
for contact in contacts:
        contact.tags.add(tag)
        contact.last_tagged_at = now()
        contact.save()
```

**Good** (`ingest.py`, looks similar but is fine):

```python
def store_events(session, events):
    session.add_all(Event(kind=e["kind"], payload=e["payload"], occurred_at=e["ts"]) for e in events)
    session.commit()
```

**Not flagged:** Writes are batched; the loop commits in deliberate fixed-size chunks; each iteration needs per-row model logic that bulk methods skip (signals, `save()` overrides) and a comment says so; the loop runs over a small fixed set of known items; or the code is a test fixture. Also fine: a literal list of a few named items written inline (seed data, fixtures, `for name in ['admin', 'staff']:`), and a loop where a comment explains why each row must go through `save()`.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [docs.djangoproject.com](https://docs.djangoproject.com/en/5.2/topics/db/optimization/)

### `py-perf-sequential-awaits`

Does the new code, inside an `async def`, await independent I/O calls one after another — a `for` loop that does `await client.get(...)`/`await fetch_x(item)` per item, or two or more consecutive awaits whose arguments don't depend on each other's results — where `asyncio.gather(...)`, `asyncio.TaskGroup` or `anyio` task groups could run them concurrently?

**Catches:** Independent awaited calls run serially in async code when they could run concurrently.

**Fix:** Run the independent calls concurrently with `asyncio.gather` or a `TaskGroup`, bounded by a semaphore if the list can be large.

**Bad** (`notifications.py`):

```python
async def notify_followers(post, followers):
    for follower in followers:
        await push.send(follower.device_token, title="New post", body=post.title)
```

**Good** (`pagination.py`, looks similar but is fine):

```python
async def fetch_all_pages(client, url):
    items = []
    while url:
        resp = await client.get(url)
        data = resp.json()
        items.extend(data["results"])
        url = data.get("next")
    return items
```

**Not flagged:** Each call needs the previous result; order matters (writes that must be sequential, a rate-limited API with a comment saying so, a DB transaction/session that must not be shared across tasks); calls are already gathered or grouped; the loop has a small fixed bound with a comment; or the code is not async.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `py-perf-unbounded-gather`

Does the new code start one concurrent task per item of a variable-length or external collection — `asyncio.gather(*[fetch(x) for x in items])`, `create_task` in a loop, or a `TaskGroup` spawning per item — for network or database calls, with no concurrency limit (`asyncio.Semaphore`, bounded queue/worker pool, chunking)?

**Catches:** Unbounded fan-out of network or DB calls over a collection whose size is not fixed.

**Fix:** Bound the concurrency with an `asyncio.Semaphore` or a fixed-size worker pool.

**Bad** (`webhooks.py`):

```python
async def fan_out(event, subscriptions):
    tasks = [asyncio.create_task(deliver(sub.url, event)) for sub in subscriptions]
    await asyncio.wait(tasks)
```

**Good** (`regions.py`, looks similar but is fine):

```python
import asyncio

REGIONS = ("us-east-1", "eu-west-1", "ap-southeast-2")


async def warm_caches(client):
    await asyncio.gather(*[client.warm(region) for region in REGIONS])
```

**Not flagged:** A semaphore, worker pool, queue or chunking bounds concurrency; the collection is a small fixed literal; or the tasks are pure CPU-free local work.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

## Ruby

### `rb-perf-n-plus-one`

Does the new code loop over ActiveRecord records (`.each`, `.map`, `.find_each`, `.sum { }`, or a view `each` block) and, inside the loop, read an association or run a query per record -- `post.author.name`, `order.line_items.sum(:price)`, `user.comments.count`, `Model.find(...)`, `Model.where(...)`, `exists?` -- without `includes`, `preload`, `eager_load`, a counter cache, or one grouped query before the loop? If the relation being looped over was built with `.includes`/`.preload`/`.eager_load` of those associations, reading them (including `.size` or Ruby block `count { }` on them) does not count.

**Catches:** Each loop iteration triggers another database query (N+1).

**Fix:** Preload associations with `includes` before the loop, or replace per-record queries with one grouped query (Rails Guides, 'Eager Loading Associations').

**Bad** (`leaderboard_presenter.rb`):

```ruby
def rows
    @users.collect do |user|
      [user.display_name, user.submissions.where(accepted: true).count, user.badges.pluck(:name).join(", ")]
    end
  end
```

**Good** (`order_csv.rb`, looks similar but is fine):

```ruby
def rows
    @orders.find_each.map do |order|
      [order.number, order.customer_id, order.total_cents, order.status, order.created_at.iso8601]
    end
  end
```

**Not flagged:** Associations are loaded up front with `includes`/`preload`/`eager_load`; counts use `counter_cache`, `size` on a preloaded association, or a grouped `count`; the relation uses `strict_loading`; the loop only reads the record's own columns or a foreign key (`post.author_id`); or the loop is not over database records. Also fine: associations already loaded with `includes`/`preload`/`eager_load` earlier in the snippet, including `.size`/`.length`/`.to_a` on those loaded associations.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [guides.rubyonrails.org](https://guides.rubyonrails.org/active_record_querying.html)

## Rust

### `rs-perf-sequential-awaits`

Does the new code `.await` independent futures one after another — a `for` loop that does `client.get(url).send().await` per item, or two or more consecutive `.await`s whose inputs don't depend on each other — where `tokio::join!`, `futures::future::join_all`/`try_join_all` or `FuturesUnordered`/`buffer_unordered` could run them concurrently?

**Catches:** Independent futures are awaited serially when they could run concurrently.

**Fix:** Run the independent futures concurrently with `join!`, `try_join_all`, or a bounded `buffer_unordered`.

**Bad** (`sync.rs`):

```rust
let customer = self.stripe.customer(customer_id).await?;
        let invoices = self.stripe.invoices_for(customer_id).await?;
        let subscriptions = self.stripe.subscriptions_for(customer_id).await?;
        Ok(CustomerSnapshot { customer, invoices, subscriptions })
```

**Good** (`fanout_joined.rs`, looks similar but is fine):

```rust
use futures::future::join_all;

pub async fn notify_all(push: &PushClient, device_tokens: &[String], msg: &Message) -> usize {
    let results = join_all(device_tokens.iter().map(|t| push.send(t, msg))).await;
    results.iter().filter(|r| r.is_ok()).count()
}
```

**Not flagged:** Each future needs the previous result; order matters (sequential writes, a rate limit with a comment, a transaction); futures are already joined or buffered; or the loop has a small fixed bound with a comment.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

## Swift

### `swift-perf-formatter-per-call`

Does the new code create a `DateFormatter`, `NumberFormatter`, `ISO8601DateFormatter`, `DateComponentsFormatter`, `MeasurementFormatter`, `ByteCountFormatter`, a configured `JSONDecoder`/`JSONEncoder`, or `NSRegularExpression` inside a loop, inside a `map`/`forEach`/`compactMap` closure, or in a function or computed property called per item (`tableView(_:cellForRowAt:)`, `collectionView(_:cellForItemAt:)`, a per-row formatting helper, `description`)?

**Catches:** An expensive Foundation formatter, decoder or regex is rebuilt for every item.

**Why it matters:** agents write `let f = DateFormatter()` inside helpers used per cell.

**Fix:** Create the formatter once (a `static let` or cached property) and reuse it, or use `FormatStyle` (Apple Data Formatting Guide).

**Bad** (`FileListFormatter.swift`):

```swift
import Foundation

enum FileListFormatter {
    static func rows(for files: [FileItem]) -> [String] {
        files.map { file in
            let sizeFormatter = ByteCountFormatter()
            sizeFormatter.countStyle = .file
            return "\(file.name) — \(sizeFormatter.string(fromByteCount: file.byteCount))"
        }
    }
}
```

**Good** (`Post.swift`, looks similar but is fine):

```swift
extension Post {
    var displayDate: String {
        createdAt.formatted(.relative(presentation: .named))
    }

    var likesText: String {
        likeCount.formatted(.number.notation(.compactName))
    }
}
```

**Not flagged:** The formatter is a `static let` or cached/injected property; `FormatStyle` APIs are used (`date.formatted(...)`, `.formatted(.number)`); it is created once per screen or request outside any loop; or the code is inside a SwiftUI `body` -- that case belongs to `swiftui-expensive-body`.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [developer.apple.com](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/DataFormatting/Articles/dfDateFormatting10_4.html)

### `swift-perf-sequential-awaits`

Does the new code await independent async calls one after another — a `for` loop that does `try await api.fetch(item)` per item, or two or more consecutive `await`s whose arguments don't depend on each other's results — where `async let` or a `withTaskGroup`/`withThrowingTaskGroup` could run them concurrently?

**Catches:** Independent awaited calls run serially when they could run concurrently.

**Fix:** Run the independent calls concurrently with `async let` or a task group.

**Bad** (`HomeLoader.swift`):

```swift
func load() async throws -> HomeContent {
        let weather = try await weatherService.current(for: location)
        let headlines = try await newsService.topHeadlines(country: "us")
        return HomeContent(weather: weather, headlines: headlines)
    }

import Foundation
import CoreLocation
```

**Good** (`HomeLoader.swift`, looks similar but is fine):

```swift
async let weather = weatherService.current(for: location)
        async let headlines = newsService.topHeadlines(country: "us")
        return try await HomeContent(weather: weather, headlines: headlines)
```

**Not flagged:** Each call needs the previous result; order matters (sequential writes, a rate limit with a comment, actor state that must update in order); calls already use `async let` or a task group; or the loop has a small fixed bound with a comment.

Holdout: precision 83%, recall 100% (5 violations in the holdout set).

## Typescript

### `ts-perf-query-per-item`

Does the new code run one database or ORM query per item of a collection -- `prisma.x.findUnique/findFirst/findMany/update/delete`, TypeORM `repository.findOne*`, Drizzle `db.select()...where(eq(...))`, Sequelize `findByPk`/`findOne`, Mongoose `findById`/`findOne`, Knex, or a raw `db.query` -- inside a `for`/`for...of`/`forEach` loop or an `items.map(...)` callback (including `Promise.all(items.map(...))`), where one query with an `in` filter or an `include`/join would fetch or change everything at once?

**Catches:** The code issues one query per element (N+1), whether sequentially or concurrently.

**Why it matters:** N+1 is named explicitly in the CodeRabbit AI-vs-human findings; `Promise.all(map(findUnique))` is a typical agent 'optimization'.

**Fix:** Fetch all rows in one query with an `in` filter or `include`/join (or `createMany`/`updateMany` for writes) and map the results by id (Prisma docs, 'Solving the n+1 problem').

**Bad** (`feed.ts`):

```ts
const withAuthors = await Promise.all(
    posts.map(async (post) => ({
      ...post,
      author: await User.findById(post.authorId).select("name avatarUrl").lean(),
    })),
  );
  return reply.send(withAuthors);
```

**Good** (`route.ts`, looks similar but is fine):

```ts
export async function POST(req: Request) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const { ids } = (await req.json()) as { ids: string[] };

  const { count } = await prisma.notification.updateMany({
    where: { id: { in: ids }, userId: session.user.id },
    data: { readAt: new Date() },
  });

  return Response.json({ updated: count });
```

**Not flagged:** Data is fetched in one query (`include`, `in`/`inArray`/`$in`, a join, `relationLoadStrategy: "join"`, a DataLoader that batches per tick); writes use `createMany`/`updateMany`/`deleteMany`/a bulk insert; each iteration needs the previous result (cursor pagination); or the loop is over a small fixed list. Whether independent calls are awaited sequentially is `ts-sequential-await-loop`'s question, not this rule's.

Holdout: precision 83%, recall 100% (5 violations in the holdout set). Sources: [www.prisma.io](https://www.prisma.io/docs/orm/prisma-client/queries/query-optimization-performance)

### `ts-perf-sync-io-in-handler`

Does the new code call a synchronous Node.js API that blocks the event loop -- `fs.readFileSync`, `writeFileSync`, `existsSync`, `readdirSync`, `statSync`, `child_process.execSync`/`spawnSync`/`execFileSync`, `zlib.*Sync`, `crypto.pbkdf2Sync`/`scryptSync` -- inside a request handler, middleware, route handler (Express/Fastify/Koa/Hono, Next.js route handler or Server Action), queue/message handler, or other code that runs per request?

**Catches:** Per-request server code blocks the event loop on synchronous I/O or crypto, stalling every other client.

**Why it matters:** agents write `fs.readFileSync` in route handlers because it is shorter.

**Fix:** Use the async API (`await fs.promises.readFile`, `promisify(crypto.scrypt)`) or move the work to startup or a worker thread (Node.js, 'Don't Block the Event Loop').

**Bad** (`compress.ts`):

```ts
import { gzipSync } from "node:zlib";

export const gzipJson: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.get("content-type")?.includes("application/json")) return;
  const body = Buffer.from(await c.res.arrayBuffer());
  c.res = new Response(gzipSync(body), {
    status: c.res.status,
    headers: { ...Object.fromEntries(c.res.headers), "content-encoding": "gzip" },
  });
};
```

**Good** (`config.ts`, looks similar but is fine):

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const Config = z.object({
  port: z.number().default(3000),
  databaseUrl: z.string().url(),
  featureFlags: z.record(z.boolean()).default({}),
});

const raw = JSON.parse(readFileSync(path.join(process.cwd(), "config.json"), "utf8"));
export const config = Config.parse(raw);
```

**Not flagged:** The sync call runs once at startup or module load (reading config at top level), in a CLI, build or migration script, or in test setup; the code uses the promise/callback API (`fs.promises`, `await readFile`, `util.promisify(crypto.pbkdf2)`, `crypto.scrypt` with a callback); or it is not server code.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [nodejs.org](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)

### `ts-perf-unbounded-list-query`

Does the new code return or send a list from a request handler (API route, controller, GraphQL resolver, Server Action, loader) that is fetched with no row limit -- `prisma.x.findMany()` without `take`, TypeORM `find()` without `take`, Drizzle `db.select().from(t)` without `.limit()`, Mongoose `Model.find({})` without `.limit()`, or `SELECT ... FROM` without `LIMIT` -- from a table that grows with usage (users, orders, events, messages, logs, comments)?

**Catches:** An endpoint returns every matching row, so response size and query time grow without bound.

**Why it matters:** list endpoints generated by agents almost always start as `findMany()` with no `take`.

**Fix:** Add pagination (`take` plus a cursor or page) with a server-enforced maximum page size (OWASP API4:2023).

**Bad** (`comments.ts`):

```ts
const comments = await Comment.find({ post: req.params.postId })
    .sort({ createdAt: -1 })
    .populate("author", "name avatarUrl")
    .lean();
  res.json(comments);
```

**Good** (`settings.controller.ts`, looks similar but is fine):

```ts
@Get("notification-preferences")
  async prefs(@CurrentUser() user: User) {
    return this.prefsRepo.find({ where: { userId: user.id }, order: { channel: "ASC" } });
```

**Not flagged:** The query sets `take`/`limit`/`LIMIT` or cursor/page parameters with a server-side maximum; it is scoped to a naturally small set (one user's settings, a fixed lookup/enum table, `where: { id: { in: ids } }` for bounded ids); it aggregates (`count`, `groupBy`, `_sum`); or it runs in a script or export job, not a request handler.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [api-security.owasp.org](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption), [www.prisma.io](https://www.prisma.io/docs/orm/prisma-client/queries/query-optimization-performance)

### `ts-perf-linear-lookup-in-loop` _(candidate)_

Does the new code search one array from inside a loop or iteration callback over another collection -- `b.find(...)`, `b.filter(...)`, `b.some(...)`, `b.includes(x)`, `b.indexOf(x)`, or `b.findIndex(...)` inside `for`/`forEach`/`map`/`filter`/`reduce` over `a` (including in a React render) -- to match items by id or key, where building a `Map`, `Set` or object index once before the loop would make each lookup constant-time?

**Catches:** A nested linear search makes the join O(n*m).

**Why it matters:** 'unindexed lookups' are listed among the AI performance findings.

**Fix:** Build a `Map`/`Set` keyed by the id once before the loop and look items up in it.

**Bad** (`permissions.ts`):

```ts
import type { Document, Share } from "./types";

export function visibleDocuments(docs: Document[], shares: Share[], userId: string) {
  return docs.filter(
    (doc) => doc.ownerId === userId || shares.some((s) => s.documentId === doc.id && s.userId === userId),
  );
}
```

**Good** (`validate.ts`, looks similar but is fine):

```ts
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function rejectedFiles(files: File[]) {
  return files.filter((f) => !ALLOWED_TYPES.includes(f.type) || f.name.includes(".."));
}
```

**Not flagged:** The lookup uses a `Map`, `Set`, object index or `Object.groupBy` built outside the loop; the searched collection is a small fixed constant (e.g. three allowed values) or a string (`str.includes`); both sides are bounded tiny lists; or the search is not inside a loop.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `ts-perf-unbounded-fan-out`

Does the new code start one concurrent request per item of a variable-length or external collection — `Promise.all(items.map(async (x) => fetch/db/sdk call))`, `Promise.allSettled` over a mapped list, or firing promises in a loop — for network or database calls, with no concurrency limit (`p-limit`, `p-map` with `concurrency`, chunking/batching, a queue)?

**Catches:** Unbounded fan-out of network or DB calls over a collection whose size is not fixed.

**Fix:** Limit concurrency with `p-limit`/`p-map` or fixed-size batches instead of mapping every item into `Promise.all`.

**Bad** (`sendReceipts.ts`):

```ts
export async function sendReceipts(orderIds: string[]) {
  const results = await Promise.allSettled(orderIds.map((id) => sendReceipt(id)));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) logger.warn({ failed }, "some receipts failed");
}
```

**Good** (`thumbnails.ts`, looks similar but is fine):

```ts
import sharp from "sharp";

export async function makeThumbnails(buffers: Buffer[]): Promise<Buffer[]> {
  return Promise.all(buffers.map(async (b) => sharp(b).resize(256, 256).webp().toBuffer()));
}
```

**Not flagged:** Concurrency is limited (`p-limit`, `p-map({ concurrency })`, `Bottleneck`, chunks of a fixed size, a queue); the collection is a small fixed literal or has an explicit small cap (`.slice(0, 5)`); the work is local/CPU-only; or items are processed sequentially (that is ts-sequential-await-loop's concern, not this rule).

Holdout: precision 100%, recall 100% (5 violations in the holdout set).
