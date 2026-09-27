# Security pack

Security mistakes you can see in the added code: secrets in client bundles or logs, unverified JWTs, SQL and shell commands built from input, SSRF, path traversal, mass assignment, record lookups not scoped to the user, Server Actions without auth, unsafe deserialization, weak password hashing and CORS that reflects any origin with credentials. It complements a SAST tool (it can't follow data across files) and is best at judgments SAST can't make, like whether a handler trusts a client-sent user id.

Each rule shows code the check flags (**bad**), similar code it leaves alone (**good**), and why. The examples are real cases from the eval set. _Candidate_ rules are still being evaluated and are not asked by the hook yet.

## Python

### `py-unscoped-object-lookup`

Does the new code add a request handler (FastAPI/Flask route, Django view, or DRF view method) that has an authenticated user available (`current_user`, `request.user`, a `Depends(get_current_user)` parameter) and loads, returns, changes or deletes a record by an id taken from the path, query or body -- `session.get(Invoice, invoice_id)`, `Invoice.objects.get(pk=pk)`, `get_object_or_404(Invoice, pk=pk)`, `db.query(Invoice).filter(Invoice.id == invoice_id).first()` -- without filtering by the owner or tenant or checking permission on the loaded record?

**Catches:** An authenticated handler fetches a user-owned record by a client-supplied id with no ownership or permission check, so any signed-in user can read or change any record (IDOR/BOLA).

**Why it matters:** agents generate CRUD endpoints from a model's fields and routinely omit ownership scoping; CodeRabbit reports 1.5-2x more security issues in AI PRs.

**Fix:** Scope the lookup to the current user or tenant (or run the object-level permission check) before returning or changing the record (OWASP API1:2023).

**Bad** (`views.py`):

```python
@login_required
def download_statement(request, pk):
    statement = get_object_or_404(Statement, pk=pk)
    return FileResponse(statement.pdf.open("rb"), as_attachment=True, filename=f"statement-{statement.period}.pdf")
```

**Good** (`views.py`, looks similar but is fine):

```python
def article_detail(request, slug):
    article = get_object_or_404(Article, slug=slug, status=Article.Status.PUBLISHED)
    liked = request.user.is_authenticated and article.likes.filter(user=request.user).exists()
    return render(request, "blog/article_detail.html", {"article": article, "liked": liked})
```

**Not flagged:** The query is scoped to the user or tenant (`user_id=current_user.id`, `request.user.invoices.get(...)`, `tenant_id=`), an object-level check runs on the record (`if obj.owner_id != user.id: raise`, `self.check_object_permissions`, `has_object_permission`, a policy call), the view relies on a scoped `get_queryset()`, the endpoint is admin-only by an explicit dependency or decorator, the resource is public by nature (published articles, product catalog), or the handler fetches the user's own record (`/me`).

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [api-security.owasp.org](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization)

### `py-secret-compare-eq`

Does the new code compare a secret or a signature with `==` or `!=` -- an HMAC digest (`hmac.new(...).hexdigest()`), a webhook signature header, an API key, a bearer, reset or CSRF token, or a password hash -- instead of `hmac.compare_digest` / `secrets.compare_digest` or the library's verify function?

**Catches:** A secret or signature is checked with `==`/`!=`, which leaks timing information.

**Why it matters:** agents hand-roll webhook signature checks (`if sig != expected:`). No direct study.

**Fix:** Compare secrets with `hmac.compare_digest(a, b)` (Python docs, hmac).

**Bad** (`middleware.py`):

```python
auth_header = request.headers.get("Authorization", "")
            if not auth_header == f"Bearer {settings.METRICS_TOKEN}":
                return HttpResponseForbidden()
```

**Good** (`deps.py`, looks similar but is fine):

```python
def bearer_token(authorization: str = Header("")) -> str:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="missing bearer token")
    return token
```

**Not flagged:** The comparison uses `hmac.compare_digest`, `secrets.compare_digest`, or a library verifier (`bcrypt.checkpw`, `argon2` `verify`, passlib `verify`, `stripe.Webhook.construct_event`, `jwt.decode`); or the values compared are not secrets (ids, status strings, usernames, content types, token *types*); or the code only checks that a secret is present (`if not token:`).

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [docs.python.org](https://docs.python.org/3/library/hmac.html)

### `py-sec-ssrf`

Does the new code, in a web handler or task (Flask/FastAPI/Django/DRF view, Celery task triggered by a request), send an outbound request -- `requests.get/post/request`, a `requests.Session`, `httpx.get`/`httpx.Client`/`AsyncClient`, `aiohttp.ClientSession().get`, `urllib.request.urlopen`, `urllib3`, `pycurl` -- to a full URL, host or base URL taken from request input (`request.args`/`request.form`/`request.json`, `request.GET`/`request.POST`/`request.data`, a FastAPI route parameter or body field such as `url: str`/`HttpUrl`/`AnyUrl`) without parsing it (`urllib.parse.urlsplit`) and checking its scheme and `hostname` against an allow-list, or resolving it and rejecting private, loopback, link-local and cloud-metadata addresses (`ipaddress.ip_address(...).is_private`)? Pydantic `HttpUrl` validation alone, or substring/`startswith` checks on the raw URL, do not count.

**Catches:** A server-side request goes to a URL or host the client chose, with no allow-list or private-address check (SSRF, CWE-918).

**Fix:** Parse the URL, allow only `https` and hosts on a fixed allow-list (or resolve and reject private/loopback/metadata IPs), and disable redirects (OWASP SSRF Prevention Cheat Sheet; API7:2023).

**Bad** (`avatar.py`):

```python
data = await request.json()
    image_url = data["image_url"]
    async with aiohttp.ClientSession() as session:
        async with session.get(image_url) as resp:
            content = await resp.read()
    key = f"avatars/{request['user'].id}.png"
    await storage.put(key, resize_to_png(content, 256))
    return web.json_response({"avatar": key})
```

**Good** (`bookmarks.py`, looks similar but is fine):

```python
@router.post("/bookmarks")
async def create_bookmark(body: BookmarkIn, user=Depends(current_user)):
    url = await validate_public_url(str(body.url))  # raises 400 for private/loopback/metadata hosts
    async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
        page = await client.get(url)
```

**Not flagged:** The URL is a constant or from settings, and request input only fills a path segment, id or query parameter on that fixed host (`f"https://api.github.com/users/{quote(login)}"`, `params={'q': q}`); the parsed hostname is checked against a fixed allow-list or resolved and checked with `ipaddress` before the request; the request goes through an SSRF-safe wrapper the code calls for that purpose (`advocate`, a `safe_fetch`/`validate_public_url` helper); the code is a CLI script or test where the operator supplies the URL; or no outbound request uses request input.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `py-sec-path-traversal`

Does the new code build a filesystem path from request or external input -- `request.args`/`request.form`/`request.view_args`, a FastAPI/Django path or query parameter, `request.files[...].filename`, `UploadFile.filename`, `request.FILES[...].name`, or an archive member name from `zipfile`/`tarfile` -- with `os.path.join`, `pathlib` `/`, `Path(...)`, `+` or an f-string, and pass it to a file operation (`open`, `Path.read_text/read_bytes/write_text/write_bytes/unlink/mkdir`, `os.remove`, `shutil.copy/move/rmtree`, `flask.send_file`, `FileResponse`, `django.http.FileResponse(open(...))`) without either reducing it to a safe name (`werkzeug.utils.secure_filename`, `os.path.basename`, a strict regex or allow-list) or resolving it and checking containment (`p = (BASE / name).resolve(); p.is_relative_to(BASE.resolve())`, `os.path.commonpath`)? `os.path.normpath` alone, and `startswith` on the unresolved input, do not count.

**Catches:** Client-controlled text becomes part of a path that is opened, written or deleted with no containment check, so `../` or an absolute path (which `os.path.join` lets replace the base) escapes the directory (CWE-22).

**Fix:** Use `secure_filename`/`send_from_directory`, or resolve the path and check `is_relative_to(base)` before opening it (OWASP Path Traversal; CWE-22).

**Bad** (`attachments.py`):

```python
target = os.path.join(settings.MEDIA_ROOT, "attachments", str(request.user.id), name)
        if os.path.exists(target):
            os.remove(target)
        return Response(status=204)
```

**Good** (`views.py`, looks similar but is fine):

```python
class ContractUploadView(LoginRequiredMixin, View):
    def post(self, request):
        upload = request.FILES["contract"]
        saved_name = default_storage.save(f"contracts/{request.user.pk}/{upload.name}", upload)
        Contract.objects.create(owner=request.user, file_path=saved_name, original_filename=upload.name)
        return redirect("contracts:list")
```

**Not flagged:** The name goes through `secure_filename`/`basename`/an allow-list, or the resolved path is checked to stay under the base; `flask.send_from_directory` or `werkzeug.security.safe_join` is used (they reject escaping paths); Django storage APIs (`default_storage.save`, `FileField.save`) which validate names; the file name is generated server-side (`uuid4().hex`); the path comes from settings or a CLI argument of an operator tool; `tarfile.extractall(..., filter='data')` (unfiltered `extractall` belongs to ruff S202); or no file operation receives request input.

Holdout: precision 100%, recall 100% (7 violations in the holdout set).

### `py-sec-mass-assignment`

Does the new code bind an unfiltered client payload onto a model -- `User(**request.json)`, `Model.objects.create(**request.data)`, `Model.objects.filter(...).update(**request.POST.dict())`, `for k, v in data.items(): setattr(obj, k, v)` or `obj.__dict__.update(data)` where `data` is a raw request dict, SQLAlchemy `update(User).values(**body)` -- or define a user-facing writable Django `ModelForm` or DRF `ModelSerializer` whose `Meta` uses `fields = "__all__"` or `exclude = [...]` on a model with privilege, ownership or billing fields (`is_staff`, `is_superuser`, `role`, `owner`, `user`, `tenant`, `balance`, `is_verified`) not listed in `read_only_fields`?

**Catches:** A client can set fields it should not control (role, ownership, tenant, billing, verification) through automatic binding (mass assignment, CWE-915).

**Fix:** List the editable fields explicitly (form/serializer `fields = [...]`, a dedicated Pydantic input schema) and set ownership/privilege fields server-side (Django ModelForm docs, 'Selecting the fields to use'; OWASP API3:2023).

**Bad** (`orgs.py`):

```python
@router.put("/orgs/{org_id}")
async def update_org(org_id: int, request: Request, db: AsyncSession = Depends(get_db)):
    body = await request.json()
    await db.execute(update(Organization).where(Organization.id == org_id).values(**body))
    await db.commit()
    return {"ok": True}
```

**Good** (`profile.py`, looks similar but is fine):

```python
data = request.get_json()
    allowed = {"display_name", "bio", "timezone"}
    user.__dict__.update({k: v for k, v in data.items() if k in allowed})
```

**Not flagged:** The payload is a Pydantic model or DRF serializer/form with an explicit field list and the code writes its validated data (`**serializer.validated_data` inside a serializer's `create()`, `payload.model_dump(exclude_unset=True)` from a dedicated `...Update` schema); `fields = [...]` is explicit or privileged fields are `read_only_fields`; ownership is set server-side after binding; the form/serializer is used only in Django admin or for read-only output; the code is a management command, fixture, migration or test; or no request data is bound.

Holdout: precision 100%, recall 83% (6 violations in the holdout set).

### `py-sec-unsafe-deserialization`

Does the new code deserialize data that can come from outside the service's control -- an HTTP request body or cookie, an uploaded file, a user-supplied path or URL, a message from a queue or socket another party can write to -- with a loader that can execute code or build arbitrary objects: `pickle.load(s)`, `dill`/`cloudpickle` `loads`, `joblib.load`, `pandas.read_pickle`, `yaml.load` without `Loader=yaml.SafeLoader` (or with `Loader`/`UnsafeLoader`/`FullLoader`), `yaml.unsafe_load`, `jsonpickle.decode`, `marshal.loads`, `shelve.open`, `torch.load(..., weights_only=False)`, or `numpy.load(..., allow_pickle=True)`?

**Catches:** Untrusted bytes reach a loader that can run arbitrary code during deserialization (CWE-502).

**Fix:** Use JSON, `yaml.safe_load`, `safetensors` or `torch.load(weights_only=True)` for data from outside the service, or authenticate it with an HMAC before unpickling (Python pickle docs; OWASP Deserialization Cheat Sheet).

**Bad** (`partner_events_consumer.py`):

```python
# "partner-events" is published to by external partners through the public AMQP gateway;
    # they now send dill-serialized job objects so we can keep their custom types.
    payload = dill.loads(body)
```

**Good** (`test_embeddings.py`, looks similar but is fine):

```python
import numpy as np
import pickle
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def test_embeddings_roundtrip():
    with open(FIXTURES / "embeddings_small.pkl", "rb") as fh:
        expected = pickle.load(fh)
    arr = np.load(FIXTURES / "embeddings_small.npy", allow_pickle=False)
    assert arr.shape == expected["shape"]
    assert np.allclose(arr[0], expected["first_row"])
```

**Not flagged:** A safe format or mode is used (`json.loads`, `yaml.safe_load`, `yaml.load(..., Loader=yaml.SafeLoader)`, `torch.load(..., weights_only=True)` or its default in torch >= 2.6, `np.load` without `allow_pickle`, `safetensors`, `msgpack`); the data was produced by this service and stored where only it can write (its own cache backend, a model artifact built by the project's pipeline, a local checkpoint); the payload's HMAC is verified with `hmac.compare_digest` before loading; the code is a test or notebook using fixture files; or nothing is deserialized.

Holdout: precision 86%, recall 100% (6 violations in the holdout set).

### `py-sec-weak-password-hash`

Does the new code hash or store a user password (or password-reset / API secret meant to be verified later) with a fast or unsalted digest — `hashlib.md5`, `hashlib.sha1`, `hashlib.sha256`/`sha512` of the password (with or without a static or concatenated salt), `hashlib.new('md5', ...)`, or storing the password in plain text or reversible encoding (`base64`, `Fernet`) — instead of a password-hashing function?

**Catches:** A password is stored or verified using a fast general-purpose hash, a static salt, plain text, or reversible encoding.

**Why it matters:** Pearce et al. (IEEE S&P 2022) note Copilot repeatedly suggests MD5/fast hashes for password storage.

**Fix:** Hash passwords with argon2id, bcrypt or scrypt (or Django's make_password) and verify with the library's constant-time check.

**Bad** (`models.py`):

```python
class ApiClient(models.Model):
    name = models.CharField(max_length=100)
    secret_hash = models.CharField(max_length=40)

    def set_secret(self, raw_secret: str) -> None:
        self.secret_hash = hashlib.sha1(raw_secret.encode()).hexdigest()

    def check_secret(self, raw_secret: str) -> bool:
        return self.secret_hash == hashlib.sha1(raw_secret.encode()).hexdigest()
```

**Good** (`views.py`, looks similar but is fine):

```python
user = form.save(commit=False)
    user.password = make_password(form.cleaned_data["password"])
    user.save()
```

**Not flagged:** Also fine: password hashing with `argon2`/`argon2-cffi`, `bcrypt`, `scrypt` (`hashlib.scrypt`), `passlib` with argon2/bcrypt, Django's `make_password`/`check_password`, or `hashlib.pbkdf2_hmac` with a random salt and a high iteration count (hundreds of thousands); hashing non-password data (cache keys, file checksums, ETags, content fingerprints, HMAC signatures); or test code.

Holdout: precision 100%, recall 100% (6 violations in the holdout set). Sources: [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [cwe.mitre.org](https://cwe.mitre.org/data/definitions/916.html)

## Ruby

### `rb-unscoped-find`

Does the new code add a Rails controller action (or `before_action` loader) that loads, updates or destroys a user-owned record with a class-level finder on a client-supplied id -- `Invoice.find(params[:id])`, `Invoice.find_by(id: params[:invoice_id])`, `Invoice.where(id: params[:id])` -- instead of scoping it through the current user or tenant (`current_user.invoices.find(params[:id])`, `Current.account.projects.find(...)`) or authorizing the loaded record?

**Catches:** A record is fetched by a request id with no ownership scope or authorization, so any signed-in user can reach any record.

**Why it matters:** scaffold-style controllers generated by agents use `Model.find(params[:id])`; CodeRabbit reports more security issues in AI PRs.

**Fix:** Load the record through the current user's or tenant's association (`current_user.invoices.find(params[:id])`) or authorize it right after loading (Rails Security Guide, 'Privilege Escalation').

**Bad** (`projects_controller.rb`):

```ruby
def destroy
    Project.where(id: params[:id]).destroy_all
    head :no_content
  end
```

**Good** (`reports_controller.rb`, looks similar but is fine):

```ruby
def show
    @report = Report.find(params[:id])
    authorize @report
    @rows = @report.rows.order(:position)
  end
```

**Not flagged:** The lookup goes through an association of `current_user`, `Current.*` or the tenant; the record is authorized right after loading (Pundit `authorize @invoice`, CanCanCan `load_and_authorize_resource`/`authorize!`, Action Policy `authorize!`, `policy_scope(...)`); the controller is in an admin namespace guarded by an explicit admin check; the model is public by nature (published posts, products); or the code is not a controller.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [guides.rubyonrails.org](https://guides.rubyonrails.org/security.html), [api-security.owasp.org](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization)

### `rb-sql-interpolation`

Does the new code put a runtime value into a SQL fragment -- interpolating with `#{...}` into a string passed to `where`, `order`, `reorder`, `joins`, `select`, `group`, `having`, `pluck`, `find_by_sql`, `exec_query`, or `execute`, or passing `params[...]` directly as the argument of `order`/`reorder`/`pluck`/`select` -- instead of placeholders (`where("name = ?", name)`, `where(name: name)`), `sanitize_sql_*`, Arel, or an allow-list?

**Catches:** A request or other runtime value becomes part of SQL text.

**Why it matters:** agents write `order("#{params[:sort]} #{params[:dir]}")` for sortable tables.

**Fix:** Use hash conditions or `?` placeholders, and map sort columns through an allow-list (Rails Guides, Active Record Query Interface / Security).

**Bad** (`contacts_controller.rb`):

```ruby
def export
    columns = params[:fields].presence || "email"
    render json: current_account.contacts.pluck(params[:fields] || "email")
  end
```

**Good** (`company.rb`, looks similar but is fine):

```ruby
class Company < ApplicationRecord
  has_many :employees

  def self.search(term)
    return none if term.blank?

    where("companies.name ILIKE ?", "%#{sanitize_sql_like(term)}%")
  end
end
```

**Not flagged:** Values go through hash conditions, `?` or named placeholders, `sanitize_sql_*`, or Arel; only a constant or a value checked against an explicit allow-list (e.g. `SORTABLE.include?(col)` or a `case` mapping) is interpolated; `order(created_at: :desc)` hash form is used; or no SQL string is built.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [guides.rubyonrails.org](https://guides.rubyonrails.org/security.html), [guides.rubyonrails.org](https://guides.rubyonrails.org/active_record_querying.html)

### `rb-privileged-attrs-permitted`

Does the new code add strong-parameter permits in a user-facing (non-admin) controller that let the client set privilege, ownership or billing fields -- `permit(..., :role, :admin, :is_admin, :account_id, :user_id, :owner_id, :organization_id, :tenant_id, :plan, :credits, :balance, :verified, :confirmed_at)` or the same keys in `params.expect(...)` -- or call `permit!`?

**Catches:** A client can assign privilege, ownership or billing attributes through mass assignment.

**Why it matters:** agents copy every model column into `permit(...)`, including `role`/`user_id`.

**Fix:** Remove privileged fields from `permit` and set them server-side, or permit them only behind an explicit admin/policy check.

**Bad** (`accounts_controller.rb`):

```ruby
def account_params
    params.require(:account).permit(:company_name, :billing_email, :plan, :credits)
  end
```

**Good** (`team_members_controller.rb`, looks similar but is fine):

```ruby
def member_params
    params.require(:user).permit(policy(@user).permitted_attributes)
  end
```

**Not flagged:** Only ordinary content fields are permitted; ownership is set server-side (`@post.user = current_user`, `current_user.posts.build(...)`); the controller is in an admin namespace or permits these keys only behind an explicit admin or policy check (`permitted_attributes(@user)` from Pundit, `if current_user.admin?`); or the `*_id` keys are references a user may legitimately choose (`category_id`, `country_id`, `assignee_id` validated elsewhere).

Holdout: precision 100%, recall 80% (5 violations in the holdout set). Sources: [guides.rubyonrails.org](https://guides.rubyonrails.org/security.html)

### `rb-line-anchor-validation-regex`

Does the new code accept or reject untrusted input (params, a URL, an email, a filename, a header, or a value guarding a redirect, file access or allow-list) with a Ruby regex anchored by `^` and/or `$` -- via `=~`, `match?`, `match`, `!~`, or `validates ... format: { with: /^...$/, multiline: true }` -- instead of `\A` and `\z`?

**Catches:** A validation regex uses line anchors, so input like `"evil\nhttps://ok.example"` passes.

**Why it matters:** `^...$` is the idiom models learn from JavaScript; in Ruby it is a bypass.

**Fix:** Anchor validation regexes with `\A` and `\z` (Rails Security Guide, 'Regular Expressions').

**Bad** (`sessions_controller.rb`):

```ruby
if params[:return_to] =~ /^https:\/\/app\.acme\.io\//
      redirect_to params[:return_to], allow_other_host: true
    else
      redirect_to root_path
    end
```

**Good** (`deploy_log_parser.rb`, looks similar but is fine):

```ruby
def errors
    @log.scan(/^ERROR\s+(.+)$/).flatten
  end

  def sections
    @log.each_line.grep(/^## /).map { |line| line.delete_prefix("## ").strip }
  end
```

**Not flagged:** The regex uses `\A` and `\z` (or `\Z`); it searches or parses multi-line text rather than accepting or rejecting a whole value; it has no anchors; or `^` appears only as a character-class negation (`[^a-z]`).

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [guides.rubyonrails.org](https://guides.rubyonrails.org/security.html)

## Rust

### `rs-debug-derive-secret`

Does the new code `#[derive(Debug)]` on a struct or enum that has a field holding a secret — `password`, `secret`, `token`, `access_token`, `refresh_token`, `api_key`, `private_key`, `client_secret`, session cookie, `Authorization` header value, card number — as a plain `String`, `Vec<u8>` or similar, so `{:?}`, `tracing` field capture or `unwrap` panic messages print it?

**Catches:** A secret-bearing field is printed verbatim by the derived Debug implementation.

**Why it matters:** Agents add `#[derive(Debug, Clone, Serialize, Deserialize)]` to every struct by reflex, including config and credential structs.

**Fix:** Wrap the secret in secrecy::SecretString or a redacting newtype, or implement Debug by hand to redact it (OWASP Logging Cheat Sheet).

**Bad** (`models.rs`):

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct CardDetails {
    pub card_number: String,
    pub exp_month: u8,
    pub exp_year: u16,
    pub cvc: String,
    pub holder_name: String,
}
```

**Good** (`smtp.rs`, looks similar but is fine):

```rust
use secrecy::SecretString;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: SecretString,
}
```

**Not flagged:** Secret fields use a redacting wrapper (`secrecy::SecretString`/`SecretBox`, a newtype whose manual `Debug` prints `***`); the type implements `Debug` by hand and skips or redacts the field; or the field only names or points to a secret (`token_expires_at`, `api_key_id`, `secret_name`, `password_hash`).

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

### `rs-sql-built-with-format`

Does the new code build a SQL statement with `format!`, `push_str`, `+` or `concat!` that interpolates a runtime value (a function parameter, request field, user input, id or search term) and pass it to a database call (`sqlx::query`/`query_as`/`query_scalar`, `execute`, `diesel::sql_query`, rusqlite `execute`/`prepare`/`query_row`, `tokio_postgres` `query`/`execute`), instead of using bind parameters?

**Catches:** Runtime values are spliced into SQL text, opening SQL injection and breaking on quotes.

**Why it matters:** Agents use `format!` for dynamic filters and `IN (...)` lists when the bind syntax for the driver is unfamiliar.

**Fix:** Pass values as bind parameters ($1 + .bind(v), params![]) instead of formatting them into the SQL string (OWASP SQL Injection Prevention Cheat Sheet).

**Bad** (`actions.rs`):

```rust
diesel::sql_query(format!(
        "UPDATE users SET active = false, deactivated_reason = '{reason}' WHERE id = {user_id}"
    ))
    .execute(conn)
```

**Good** (`lookup.rs`, looks similar but is fine):

```rust
pub async fn find_active(pool: &PgPool, email: &str) -> sqlx::Result<Option<User>> {
    sqlx::query_as::<_, User>("SELECT id, email, display_name FROM users WHERE email = $1 AND active")
        .bind(email)
        .fetch_optional(pool)
        .await
}
```

**Not flagged:** Values are passed as bind parameters (`$1`/`?` with `.bind(v)`, `params![]`, `&[&v]`, `sqlx::query!`); the interpolated part is a compile-time constant or chosen from a fixed allowlist or enum of identifiers (table or column names, `ASC`/`DESC`); a query builder adds the values (`QueryBuilder::push_bind`, SeaQuery, Diesel DSL); or the string isn't SQL.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html), [cwe.mitre.org](https://cwe.mitre.org/data/definitions/89.html)

## Typescript

### `ts-secret-in-public-env`

Does the new code read or declare a client-exposed environment variable — one prefixed `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `EXPO_PUBLIC_`, `NUXT_PUBLIC_`, `GATSBY_`, or SvelteKit/Astro `PUBLIC_` — that holds a server secret: a secret or private API key for a paid or privileged service (OpenAI, Anthropic, Stripe secret key, SendGrid), an access token, a password, a signing or encryption key, a database URL, or a service-role/admin key (e.g. `import.meta.env.VITE_OPENAI_API_KEY`, `process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`)?

**Catches:** A secret credential is read through a public-prefixed env var, so the bundler inlines it into the JavaScript shipped to every visitor.

**Why it matters:** Agents asked to 'call OpenAI from the app' in a Vite/Next front end reach for `import.meta.env.VITE_…_API_KEY` to make the browser call work; vendor scans of vibe-coded apps report hundreds of secrets exposed in client bundles.

**Fix:** Move the call behind a server route or function that reads an unprefixed env var; never put secrets in NEXT_PUBLIC_/VITE_-style variables (Vite env docs, Next.js data security guide).

**Bad** (`env.ts`):

```ts
client: {
    NEXT_PUBLIC_APP_URL: z.string().url(),
    NEXT_PUBLIC_DATABASE_URL: z.string().url(),
    NEXT_PUBLIC_RESEND_API_KEY: z.string().min(1),
  },

  runtimeEnv: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_DATABASE_URL: process.env.NEXT_PUBLIC_DATABASE_URL,
    NEXT_PUBLIC_RESEND_API_KEY: process.env.NEXT_PUBLIC_RESEND_API_KEY,
```

**Good** (`sentry.client.ts`, looks similar but is fine):

```ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_TRACES_SAMPLE_RATE ?? 0.1),
  enabled: process.env.NEXT_PUBLIC_ENABLE_SENTRY === "true",
});
```

**Not flagged:** The public-prefixed variable is meant to be public: a publishable key (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `pk_…`), a Supabase/Firebase anon or client-config key, an analytics id, a Sentry DSN, a browser-restricted Maps key, a public API base URL, or a feature flag. Unprefixed server-only variables (`process.env.OPENAI_API_KEY` in a route handler or server module) do not count. Literal secret values written in the code belong to ts-no-hardcoded-secret.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [vite.dev](https://vite.dev/guide/env-and-mode), [nextjs.org](https://nextjs.org/docs/app/guides/data-security)

### `ts-secret-env-fallback`

Does the new code read a secret or security setting from the environment with a hardcoded fallback — `process.env.JWT_SECRET || 'secret'`, `process.env.SESSION_SECRET ?? 'dev-secret'`, `const { API_KEY = 'changeme' } = process.env`, `ADMIN_PASSWORD ?? 'admin'`, or an env schema entry like `JWT_SECRET: z.string().default('dev')` — so the app silently runs with a known value when the variable is missing, instead of failing at startup?

**Catches:** A secret, signing key, password or credential falls back to a literal value when its env var is unset.

**Why it matters:** Agents make the app 'run out of the box' by adding `|| 'your-secret-key'` placeholders; these ship to production when the env var is forgotten and make JWTs/sessions forgeable.

**Fix:** Fail fast when the secret is missing (validate env at startup and throw) instead of falling back to a known value (CWE-1188).

**Bad** (`app.ts`):

```ts
app.use(
  "/admin/*",
  basicAuth({
    username: process.env.ADMIN_USER ?? "admin",
    password: process.env.ADMIN_PASSWORD ?? "admin",
  }),
);

app.route("/admin", adminRoutes);
```

**Good** (`session.ts`, looks similar but is fine):

```ts
const isTest = process.env.NODE_ENV === "test";

export const sessionSecret = isTest
  ? "test-only-session-secret"
  : (process.env.SESSION_SECRET ?? (() => { throw new Error("SESSION_SECRET is not set"); })());
```

**Not flagged:** A missing secret throws or fails validation (an env schema without a default, `requireEnv('JWT_SECRET')`, `if (!secret) throw …`); fallbacks for non-secret settings (port, host, log level, public base URL, timeouts, feature flags, region); the fallback is inside a branch that is explicitly test-only. Real-looking literal secrets (e.g. `sk_live_…`) belong to ts-no-hardcoded-secret.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [cwe.mitre.org](https://cwe.mitre.org/data/definitions/1188.html)

### `ts-insecure-random-secret`

Does the new code use `Math.random()` (directly or through a helper built on it, e.g. `Math.random().toString(36).slice(2)`) to produce a value that must be unguessable — a session, API or refresh token, password or password-reset code, OTP or verification code, invite or share-link id, nonce, CSRF token, or salt — instead of `crypto.randomUUID()`, `crypto.getRandomValues()`, or `crypto.randomBytes()`?

**Catches:** A security-sensitive value is generated with Math.random.

**Why it matters:** The `Math.random().toString(36).substring(2)` token idiom is extremely common in training data and agents reuse it for reset codes, invite links and API keys.

**Fix:** Generate secrets with crypto.randomUUID()/crypto.getRandomValues()/crypto.randomBytes(), never Math.random (MDN Math.random, CWE-338).

**Bad** (`route.ts`):

```ts
const shareId = Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
  await db.update(boards).set({ shareId, sharedAt: new Date() }).where(and(eq(boards.id, id), eq(boards.ownerId, session.user.id)));
  return Response.json({ url: `${process.env.APP_URL}/s/${shareId}` });
```

**Good** (`Quiz.tsx`, looks similar but is fine):

```ts
const ordered = useMemo(
  () => [...questions].sort(() => Math.random() - 0.5),
  [questions],
);
const tokenLabel = `q-${Math.random().toString(36).slice(2, 7)}`;
```

**Not flagged:** Math.random is used for something that need not be unguessable: UI or animation jitter, retry backoff jitter, sampling rates, shuffling display order, games, test or seed data, temporary DOM ids, log correlation ids; or the value comes from `crypto`, `nanoid`, `uuid`, or a library token generator.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [developer.mozilla.org](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/random), [cwe.mitre.org](https://cwe.mitre.org/data/definitions/338.html)

### `ts-secret-compare-not-constant-time`

Does the new code compare a secret against caller-supplied input with `===`, `==`, `!==`, `!=`, or `buf.equals(…)` — e.g. a webhook signature or HMAC digest (`signature === expected`), an API key or bearer token from a request header (`req.headers['x-api-key'] === process.env.API_KEY`), or a stored reset token — instead of `crypto.timingSafeEqual` on equal-length buffers or `crypto.subtle.verify`?

**Catches:** A secret or signature is checked with an ordinary equality comparison against request input.

**Why it matters:** Agents writing webhook handlers from memory compute the HMAC correctly and then compare with `===`; GitHub's docs call this out explicitly.

**Fix:** Compare secrets with crypto.timingSafeEqual on equal-length buffers or use the provider's verifier (GitHub webhook validation docs).

**Bad** (`admin.ts`):

```ts
admin.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
  if (token == null || token != c.env.ADMIN_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
```

**Good** (`route.ts`, looks similar but is fine):

```ts
export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature")!;
  const event = stripe.webhooks.constructEvent(await req.text(), signature, process.env.STRIPE_WEBHOOK_SECRET!);
  if (event.type === "invoice.paid") {
    await markInvoicePaid(event.data.object.id);
  }
  return new Response(null, { status: 200 });
}
```

**Not flagged:** The comparison uses `crypto.timingSafeEqual`, `crypto.subtle.verify`, or a library verifier (`stripe.webhooks.constructEvent`, `jwt.verify`/`jwtVerify`, `bcrypt.compare`, `argon2.verify`); the compared values are not secrets (ids, roles, status strings, event types, usernames, public keys); only lengths are compared; there is no comparison of a secret.

Holdout: precision 100%, recall 100% (6 violations in the holdout set). Sources: [docs.github.com](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [nodejs.org](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)

### `ts-jwt-decode-without-verify`

Does the new code read claims from a JWT with a decode-only function — `jwt.decode(…)` (jsonwebtoken), `jwtDecode(…)` (jwt-decode), `decodeJwt(…)` (jose), or manual `JSON.parse(atob(token.split('.')[1]))` / `Buffer.from(part, 'base64')` — in server, API or middleware code and then use those claims to authenticate or authorize (user id, role, tenant, scopes, `exp`) without verifying the signature?

**Catches:** Server-side code trusts claims from a token whose signature was never verified.

**Why it matters:** When verification fails with a wrong key or algorithm, agents 'fix' auth by switching to decode; middleware that decodes Supabase/Firebase tokens for a user id is a common generated pattern.

**Fix:** Verify the signature (jwt.verify / jose jwtVerify) before trusting any claim (jsonwebtoken README: decode 'will not verify whether the signature is valid').

**Bad** (`tenant.ts`):

```ts
app.use("/api/*", async (c, next) => {
  const token = c.req.header("authorization")?.split(" ")[1];
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  if (payload.exp * 1000 < Date.now()) return c.json({ error: "expired" }, 401);
  c.set("tenantId", payload.tenant_id);
  c.set("userId", payload.sub);
  await next();
});
```

**Good** (`verify.ts`, looks similar but is fine):

```ts
export async function getUser(token: string) {
  const { payload } = await jwtVerify(token, JWKS, { issuer: "https://auth.example.com/", audience: "api" });
  const header = decodeProtectedHeader(token);
  logger.debug({ kid: header.kid }, "verified token");
  return { id: payload.sub!, roles: (payload.roles as string[]) ?? [] };
}
```

**Not flagged:** The token is verified first (`jwt.verify`, jose `jwtVerify`, `verifyIdToken`, a framework auth helper such as NextAuth/Auth.js, Clerk or Auth0 SDK); decoding happens in browser code only to show the user's name or schedule a refresh while the server still verifies; the test itself created the token; there is no JWT decoding.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [github.com](https://github.com/auth0/node-jsonwebtoken), [nextjs.org](https://nextjs.org/docs/app/guides/data-security)

### `ts-sql-interpolated-raw-query`

Does the new code build SQL text by inserting a runtime value with string concatenation or an untagged template literal (`` `SELECT * FROM users WHERE id = ${id}` ``, `'… WHERE name = \'' + name + '\''`) and execute it — with `db.query`, `pool.query`, `client.query`, `connection.execute`, `knex.raw`, `sequelize.query`, `prisma.$queryRawUnsafe`/`$executeRawUnsafe`, `sql.raw`/`sql.unsafe`, or `db.exec` — instead of bound parameters?

**Catches:** A runtime value is spliced into SQL text that is executed.

**Why it matters:** Veracode tests SQL injection among its CWEs; agents switch from tagged `$queryRaw` to `$queryRawUnsafe` or string templates to get dynamic ORDER BY/IN lists working.

**Fix:** Pass values as bound parameters or use a parameterizing tagged template; never splice them into SQL text (OWASP SQL Injection Prevention; Prisma raw-query docs).

**Bad** (`users.ts`):

```ts
export async function searchUsers(term: string) {
  return db.execute(
    sql.raw(`SELECT id, email, display_name FROM users WHERE display_name ILIKE '%${term}%' OR email ILIKE '%${term}%'`),
  );
}
```

**Good** (`tickets.ts`, looks similar but is fine):

```ts
export async function ticketsForEvent(eventId: string) {
  const { rows } = await pool.query("SELECT * FROM tickets WHERE event_id = $1", [eventId]);
  return rows;
}
```

**Not flagged:** Values go through parameterizing tagged templates (`sql`…${id}…``, `prisma.$queryRaw`…``, Drizzle `sql`…``, postgres.js, slonik), placeholders with a params array (`query('… WHERE id = $1', [id])`, `?`), or an ORM/query builder (`where({ id })`); only constants or identifiers checked against an allow-list are interpolated; no SQL is executed.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html), [www.prisma.io](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries)

### `ts-shell-command-interpolation`

Does the new code run a shell command whose text includes a runtime value — `exec(`git checkout ${branch}`)`, `execSync('convert ' + file + ' out.png')`, `spawn(cmd, { shell: true })` or `execFile(…, { shell: true })` with an interpolated command, or `spawn('sh', ['-c', `… ${x}`])` — instead of passing arguments as an array to a no-shell API?

**Catches:** A variable is interpolated into a command string that a shell parses.

**Why it matters:** Agents writing CLI tools and build scripts default to `execSync(`…${x}`)` because it is shortest.

**Fix:** Pass arguments as an array to execFile/spawn without a shell (Node child_process docs: 'Never pass unsanitized user input to this function').

**Bad** (`avatars.ts`):

```ts
const file = req.file!;
  const output = path.join(AVATAR_DIR, `${req.user.id}.png`);
  execSync("convert " + file.path + " -resize 256x256^ -gravity center -extent 256x256 " + output);
  await fs.unlink(file.path);
  res.json({ url: `/avatars/${req.user.id}.png` });
```

**Good** (`health.ts`, looks similar but is fine):

```ts
export function diskUsage() {
  return execSync("df -h / | tail -1", { encoding: "utf8" }).trim();
}
```

**Not flagged:** `execFile`/`execFileSync`/`spawn(bin, [args])` without `shell: true`; Bun Shell `$`…${x}`` and zx `$`…`` tagged templates (they quote interpolations); a constant command; values quoted with a proper library (`shell-quote`); no command is run.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [nodejs.org](https://nodejs.org/api/child_process.html), [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)

### `ts-regexp-from-input`

Does the new code pass a runtime string that comes from user or external input — a search query, request or URL parameter, form field, filename, or API field — into `new RegExp(…)`/`RegExp(…)` without escaping it (`RegExp.escape`, lodash `escapeRegExp`, or a `replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` helper), so special characters change the pattern or enable ReDoS?

**Catches:** Unescaped user or external text becomes part of a regular expression.

**Why it matters:** Search/filter features generated by agents commonly do `new RegExp(query, 'i')` to get case-insensitive matching.

**Fix:** Escape the input with RegExp.escape (or escapeRegExp), or use string methods like includes() (MDN RegExp.escape; OWASP ReDoS).

**Bad** (`tags.ts`):

```ts
const tag = c.req.query("tag");
  const posts = await listPosts(c.env.DB);
  if (!tag) return c.json(posts);
  const re = new RegExp(`(^|,)${tag}(,|$)`);
  return c.json(posts.filter((p) => re.test(p.tags)));
```

**Good** (`patterns.ts`, looks similar but is fine):

```ts
const PREFIXES = ["INV", "PO", "CR"] as const;
export const docNumber = new RegExp(`^(${PREFIXES.join("|")})-\\d{6}$`);
export const slug = new RegExp("^[a-z0-9]+(?:-[a-z0-9]+)*$");
```

**Not flagged:** The string is escaped first; the pattern is a constant or built only from constants; the pattern is intentionally supplied by a trusted developer or admin setting and the code says so; the input is matched with `includes`/`indexOf`/`startsWith`/`localeCompare` instead; there is no RegExp constructor.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [developer.mozilla.org](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/escape), [owasp.org](https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS)

### `ts-open-redirect`

Does the new code redirect to a URL taken from request or page input — `res.redirect(req.query.next)`, `redirect(searchParams.get('returnTo'))`, `NextResponse.redirect(new URL(callbackUrl))`, `window.location.href = params.get('redirect')` — without checking that it is a same-site relative path or on an allow-list of hosts?

**Catches:** A redirect target comes straight from a query/body/form parameter.

**Why it matters:** Login flows generated by agents add `?next=`/`?returnTo=` support and pass it straight to redirect.

**Fix:** Redirect only to relative paths or allow-listed hosts, or map an id to a known URL (OWASP Unvalidated Redirects and Forwards Cheat Sheet).

**Bad** (`LoginPage.tsx`):

```ts
async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await api.login(String(form.get("email")), String(form.get("password")));
    window.location.href = params.get("redirect") ?? "/app";
  }
```

**Good** (`actions.ts`, looks similar but is fine):

```ts
export async function afterCreate(id: string) {
  revalidatePath("/projects");
  redirect(`/projects/${encodeURIComponent(id)}/settings`);
}
```

**Not flagged:** The target is a constant or an internal route built by the code; the input is validated (starts with a single `/` and not `//` or `/\`, or is parsed with `new URL` and its origin compared to an allow-list); an id or slug is inserted into a fixed internal path (`/users/${id}`); the auth library validates `callbackUrl` itself; there is no redirect.

Holdout: precision 100%, recall 100% (4 violations in the holdout set). Sources: [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html), [nextjs.org](https://nextjs.org/docs/app/guides/data-security)

### `react-server-action-missing-auth`

Does the new code define a Server Function / Server Action (an `async` function in a `'use server'` file or containing a `'use server'` directive) that changes data by calling the database client or an external service SDK directly (`db.`, `prisma.`, `sql\``, `stripe.`, `resend.`, `fs.writeFile`) — an insert, update, delete, payment, email send, file write, or privileged API call — without first checking the caller's session or permission inside that function (`auth()`, `getSession()`, `currentUser()`, `verifySession()` or equivalent, followed by a throw/redirect/return when it fails)? An action that only calls imported data-access functions (`archiveProject(id)` from `@/lib/dal`) does not count: authorization may live there.

**Catches:** A mutating Server Action calls the DB or a privileged service with no session or permission check in its body.

**Why it matters:** Agents protect the page (redirect if logged out) and assume the action inside is protected; Next.js docs single this out because actions are reachable by direct POST.

**Fix:** Verify the session and the user's permission inside every Server Action before mutating (Next.js data security guide; react.dev 'use server').

**Bad** (`page.tsx`):

```ts
<ProjectHeader project={project} />
      <form
        action={async () => {
          'use server'
          await db
            .update(projects)
            .set({ archivedAt: new Date() })
            .where(eq(projects.id, project.id))
          revalidatePath('/projects')
        }}
      >
        <button type="submit" className="btn-danger">Archive project</button>
      </form>
      <ProjectTimeline events={project.events} />
```

**Good** (`actions.ts`, looks similar but is fine):

```ts
'use server'

import { cancelBookingForCurrentUser } from "@/data/bookings";
import { revalidateTag } from "next/cache";

export async function cancelBooking(bookingId: string) {
  await cancelBookingForCurrentUser(bookingId);
  revalidateTag("bookings");
}
```

**Not flagged:** The action checks the session and permission before mutating; it is wrapped by an auth-enforcing helper (`authedAction(…)`, a next-safe-action client with auth middleware); it only calls named data-access functions rather than the DB client directly (authorization may live there); it is a public, read-only action (search, contact form that only sends to the site owner with rate limiting) or only sets UI cookies such as theme or locale; the code is not a server function.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [react.dev](https://react.dev/reference/rsc/use-server), [nextjs.org](https://nextjs.org/docs/app/guides/data-security)

### `react-server-action-client-identity`

Does the new code, inside a Server Function / Server Action (`'use server'`), take the acting user's identity, privileges or a trusted amount from its arguments or `formData` — a `userId`, `ownerId`, `authorId`, `role`, `isAdmin`, `tenantId`/`orgId`, or a price/total the server should compute — and use it to decide what to write or whether the caller is allowed, instead of reading it from the server-side session or database?

**Catches:** The action trusts a client-sent user id, role, tenant or price.

**Why it matters:** Agents thread `userId` from a client component into the action because the client already has it; this is the classic IDOR the Next.js guide warns about.

**Fix:** Derive the user, role, tenant and amounts from the server session and database, never from Server Action arguments (react.dev: arguments are fully client-controlled).

**Bad** (`actions.ts`):

```ts
'use server'
  const { userId } = await auth()
  if (!userId) throw new Error('Unauthorized')

  const [project] = await db
    .insert(projects)
    .values({ orgId, name, createdBy: userId })
    .returning({ id: projects.id })
  revalidatePath(`/orgs/${orgId}/projects`)
  return { id: project.id }
```

**Good** (`actions.ts`, looks similar but is fine):

```ts
'use server'

import { currentUser } from "@/lib/auth";
import { db } from "@/server/db";

export async function lockAccount(targetUserId: string) {
  const me = await currentUser();
  if (!me || me.role !== "admin") throw new Error("Forbidden");
  await db.user.update({ where: { id: targetUserId }, data: { lockedAt: new Date() } });
  return { locked: true };
}
```

**Not flagged:** Identity and role come from the session (`session.user.id`, `auth().userId`); client-sent ids only name the target resource and the code checks ownership against the session; amounts are recomputed on the server from product ids; the action is not a server function.

Holdout: precision 100%, recall 83% (6 violations in the holdout set). Sources: [react.dev](https://react.dev/reference/rsc/use-server), [nextjs.org](https://nextjs.org/docs/app/guides/data-security)

### `react-server-action-returns-record`

Does the new code, inside a Server Function / Server Action (`'use server'`), return a raw database or ORM record to the client — `return db.user.update(…)`, `return await prisma.user.findUnique({ where })` with no `select`, or `return user` straight from a query — instead of returning only the fields the UI needs?

**Catches:** A Server Action serializes a whole database record back to the browser.

**Why it matters:** Returning the updated record is the shortest way to refresh client state, so agents do it by default; records often include password hashes, emails, internal flags.

**Fix:** Return only the fields the UI needs, not the database record (Next.js data security guide, 'Controlling return values').

**Bad** (`actions.ts`):

```ts
'use server'

import { db } from '@/lib/db'
import { requireSession } from '@/lib/session'

export async function getBillingAccount() {
  const session = await requireSession()
  const account = await db.billingAccount.findFirst({
    where: { userId: session.userId },
  })
  return account
}
```

**Good** (`actions.ts`, looks similar but is fine):

```ts
'use server'

import { prisma } from "@/lib/prisma";

export async function searchExhibits(term: string) {
  const exhibits = await prisma.exhibit.findMany({
    where: { published: true, title: { contains: term, mode: "insensitive" } },
    select: { id: true, title: true, hall: true, thumbnailUrl: true },
    take: 20,
  });
  return exhibits;
}
```

**Not flagged:** It returns a small object built for the client (`{ success: true }`, `{ id, name }`, a validation-error object), a query with an explicit `select` of public fields, the result of a DTO/mapping function, nothing (redirect/revalidate only); the code is not a server function.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [nextjs.org](https://nextjs.org/docs/app/guides/data-security), [react.dev](https://react.dev/reference/rsc/use-server)

### `react-unsanitized-html`

Does the new code pass content that may come from users or external sources — a database field, API or CMS response, markdown rendered to an HTML string, a URL parameter, or a prop of unknown origin — to `dangerouslySetInnerHTML` (or assign it to `innerHTML`/`outerHTML`/`insertAdjacentHTML` inside a component or effect) without sanitizing it with DOMPurify `sanitize`, `sanitize-html`, or an equivalent sanitizer?

**Catches:** Untrusted HTML reaches the DOM unsanitized.

**Why it matters:** Veracode reports an 86% failure rate on XSS tasks for generated code; agents render markdown/CMS content with `marked()` + dangerouslySetInnerHTML.

**Fix:** Sanitize with DOMPurify (or render to React elements) before dangerouslySetInnerHTML (react.dev: 'Only use dangerouslySetInnerHTML with trusted and sanitized data').

**Bad** (`PromoBanner.tsx`):

```ts
useEffect(() => {
    cms.getBlock(slot).then((block) => {
      containerRef.current?.insertAdjacentHTML('beforeend', block.markup)
    })
  }, [slot])
```

**Good** (`PostContent.tsx`, looks similar but is fine):

```ts
import DOMPurify from "isomorphic-dompurify";

export function PostContent({ bodyHtml }: { bodyHtml: string }) {
  const clean = DOMPurify.sanitize(bodyHtml, { USE_PROFILES: { html: true } });
  return <div className="prose" dangerouslySetInnerHTML={{ __html: clean }} />;
}
```

**Not flagged:** The HTML is sanitized first; it is a static string or built only from constants in the code; it is JSON-LD produced by a serializer that escapes `<`; markdown is rendered to React elements (react-markdown without `rehype-raw`) instead of an HTML string; there is no raw-HTML sink.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [react.dev](https://react.dev/reference/react-dom/components/common), [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)

### `ts-sec-ssrf`

Does the new code, in server-side code (an Express/Fastify/Hono/Koa/NestJS handler, a Next.js route handler or Server Action, a webhook or worker), send an outbound request -- `fetch`, `axios`, `got`, `ky`, `undici.request`, `http.get`/`https.request`, `superagent`, or a headless browser `page.goto` -- to a full URL, host or base URL taken from request input (`req.query`/`req.body`/`req.params`, `c.req.query()`/`c.req.json()`, `searchParams.get(...)`, `await request.json()`, `formData.get(...)`, a Server Action argument) without parsing it with `new URL()` and checking its protocol and `hostname`/`origin` against an allow-list, or blocking private, loopback, link-local and cloud-metadata addresses? String checks on the raw URL (`url.startsWith('https://')`, `url.includes('example.com')`) do not count as validation.

**Catches:** A server-side request goes to a URL or host the client chose, with no allow-list or private-address check, so a caller can make the server reach internal services or `169.254.169.254` (SSRF, CWE-918).

**Fix:** Parse the URL with `new URL()`, allow only `https:` and hosts on a fixed allow-list (or resolve it and reject private/loopback/metadata addresses) and disable redirects (OWASP SSRF Prevention Cheat Sheet; API7:2023).

**Bad** (`screenshot.ts`):

```ts
const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(request.query.url, { waitUntil: "networkidle" });
    const png = await page.screenshot({ type: "png" });
    await browser.close();
    return reply.type("image/png").send(png);
```

**Good** (`UrlPreview.tsx`, looks similar but is fine):

```ts
"use client";

import { useEffect, useState } from "react";

export function UrlPreview({ url }: { url: string }) {
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { method: "HEAD", mode: "no-cors", signal: controller.signal })
      .then(() => setStatus("ok"))
      .catch(() => setStatus("error"));
    return () => controller.abort();
  }, [url]);

  return <span className={`badge badge-${status}`}>{url}</span>;
}
```

**Not flagged:** The URL is a constant or comes from config/env, and request input only fills a path segment, id or query value on that fixed host (`` `https://api.github.com/users/${encodeURIComponent(login)}` ``); the parsed hostname is checked against a fixed allow-list, or the request goes through an SSRF-filtering agent or a helper the code calls for that purpose (`request-filtering-agent`, `ssrf-req-filter`, `assertPublicUrl(url)`); the code runs in the browser (`'use client'` component, React hook), where the user can only reach their own network; or no outbound request uses request input at all.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `ts-sec-path-traversal`

Does the new code build a filesystem path from request or external input -- a route param, query or body field, `formData.get(...)`, an uploaded file's `originalname`/`file.name`, or an archive entry name (`entry.path`, `entry.fileName` from tar/unzipper/yauzl) -- with `path.join`, `path.resolve`, `+` or a template literal, and pass it to a file API (`fs.readFile`/`writeFile`/`createReadStream`/`createWriteStream`/`unlink`/`rm`/`mkdir`, `fs/promises`, `res.sendFile` without a `root` option, `res.download`, `Bun.file`, `Bun.write`, `Deno.readFile`) without either reducing it to a safe name (`path.basename`, a strict pattern like `/^[\w-]+\.png$/`, an allow-list or enum) or resolving it and checking the result stays inside the base directory (`const p = path.resolve(base, name); if (!p.startsWith(base + path.sep)) throw ...`)? `path.join`/`path.normalize` alone, and `startsWith` on the unresolved input, do not count.

**Catches:** Client-controlled text becomes part of a path that is read, written or deleted with no containment check, so `../` or an absolute path escapes the intended directory (CWE-22).

**Fix:** Resolve the path and verify it stays inside the base directory (or use `path.basename`/an allow-list of names) before touching the file (OWASP Path Traversal; CWE-22).

**Bad** (`themes.ts`):

```ts
if (entry.type === "Directory") continue;
    const outPath = path.resolve(THEMES_DIR, entry.path);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(outPath));
```

**Good** (`invoices.ts`, looks similar but is fine):

```ts
router.get("/invoices/:file/download", (req, res) => {
  res.sendFile(req.params.file, { root: INVOICE_PDF_DIR, dotfiles: "deny" }, (err) => {
    if (err) res.status(404).end();
  });
});
```

**Not flagged:** The name is reduced with `path.basename` or matched against a strict pattern/allow-list; the path is resolved and checked to stay under the base dir; the file name is generated server-side (`${crypto.randomUUID()}.png`, a DB id looked up server-side); `res.sendFile(name, { root: dir })` or `express.static`/`serve-static` (they reject `..` outside root); the path comes from config, a constant, or a CLI argument of a developer tool; or no file API receives request input.

Holdout: precision 100%, recall 100% (5 violations in the holdout set).

### `ts-sec-mass-assignment`

Does the new code, in a server handler or Server Action, pass the whole client payload -- `req.body`, `await request.json()`, `await c.req.json()`, `Object.fromEntries(formData)`, or a spread of it (`{ ...body }`) -- into a create or update: `prisma.x.create/update/upsert({ data: body })`, Mongoose `Model.create(body)`/`findByIdAndUpdate(id, body)`/`doc.set(body)`, Drizzle `.values(body)`/`.set(body)`, TypeORM `repo.save({ ...entity, ...body })`/`repo.update(id, body)`, Sequelize `Model.update(body, ...)`, `knex(...).update(body)`, or `Object.assign(record, body)` before saving -- when the payload has not first been narrowed to the editable fields? A TypeScript cast or annotation (`req.body as UpdateUserInput`, `const body: UserUpdate = await req.json()`) is not narrowing.

**Catches:** The raw client payload is bound onto a stored record, so a client can also set fields such as `role`, `isAdmin`, `ownerId`, `tenantId`, `balance`, `emailVerified` or `stripeCustomerId` (mass assignment, CWE-915).

**Fix:** Validate the body with a schema that lists only the client-editable fields (or pick them explicitly) and write that, never the raw body (OWASP Mass Assignment Cheat Sheet; API3:2023).

**Bad** (`productController.ts`):

```ts
export async function createProduct(req: Request, res: Response) {
  const input = req.body as CreateProductInput;
  const product = await Product.create({ ...input, createdBy: req.user.id });
  res.status(201).json(product);
}
```

**Good** (`users.controller.ts`, looks similar but is fine):

```ts
@Patch(":id")
  @Roles("admin")
  @UseGuards(JwtAuthGuard, RolesGuard)
  update(@Param("id") id: string, @Body() body: AdminUpdateUserDto) {
    return this.users.update(id, body);
  }
```

**Not flagged:** The payload is parsed by a schema that lists the allowed fields (`UpdateProfileSchema.parse(body)`, valibot/yup/arktype, a NestJS DTO with `ValidationPipe({ whitelist: true })`) and the parsed result is written -- unless the schema is `.passthrough()`, `z.any()` or `z.record(...)`; specific fields are picked (`const { name, bio } = body`, `_.pick(body, ['name','bio'])`, `data: { name: body.name }`); the handler is visibly admin-only; the code is a seed, migration, test or client-side form state; or no client payload reaches a write.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `ts-sec-unscoped-record-lookup`

Does the new code add a server handler (Express/Fastify/Hono/Koa route, NestJS controller method, Next.js route handler or Server Action, tRPC `protectedProcedure`) that has an authenticated user available (`req.user`, `session.user`, `await auth()`, `getServerSession()`, `ctx.session`, `c.get('user')`) and loads, returns, updates or deletes a user-owned record by an id taken from the path, query, body or action argument -- `prisma.invoice.findUnique({ where: { id } })`, `update`/`delete` with `where: { id }`, `Invoice.findById(req.params.id)`, `db.select().from(invoices).where(eq(invoices.id, id))`, `repo.findOneBy({ id })` -- without also filtering by the owner or tenant (`where: { id, userId: session.user.id }`) or checking ownership/permission on the loaded record before using it?

**Catches:** A signed-in handler fetches or changes a record by a client-supplied id with no ownership or permission check, so any user can reach any record (IDOR/BOLA, API1:2023).

**Fix:** Scope the lookup to the current user or tenant (or run an object-level permission check) before returning or changing the record (OWASP API1:2023).

**Bad** (`notes.ts`):

```ts
export async function archiveNote(noteId: string) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  await db.update(notes).set({ archivedAt: new Date() }).where(eq(notes.id, noteId));
  revalidatePath("/notes");
}
```

**Good** (`articles.ts`, looks similar but is fine):

```ts
articles.get("/:slug", async (c) => {
  const viewer = c.get("user");
  const [article] = await db.select().from(posts).where(and(eq(posts.slug, c.req.param("slug")), eq(posts.status, "published")));
  if (!article) return c.notFound();
  return c.json({ ...article, canEdit: viewer?.id === article.authorId });
});
```

**Not flagged:** The query includes the user or tenant (`userId: session.user.id`, `orgId: ctx.org.id`, a `tenantDb`/RLS-scoped client); the record is checked right after loading (`if (invoice.userId !== user.id) return 404`, `ability.can(...)`, a policy/`authorize()` call); the endpoint is visibly admin-only; the resource is public by nature (published posts, product catalog); the handler loads the user's own record (`/me`, `where: { id: session.user.id }`); or the code only calls a named data-access function (authorization may live there). A missing session check altogether in a Server Action belongs to react-server-action-missing-auth; identity taken from action arguments belongs to react-server-action-client-identity.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `ts-sec-secret-in-log`

Does the new code write a secret or credential to a log or telemetry sink -- `console.log/info/warn/error/debug`, `logger.*`/`log.*` (pino, winston, bunyan), `Sentry.captureMessage`/`setExtra`/`setContext`, `span.setAttribute` -- where the logged value is a password, an access/refresh/bearer/session/reset/API token or key, the `Authorization` or `Cookie` header, the whole `req.headers`, the whole body of a login/signup/password-reset/token request, a private key or client secret, a connection string with a password, or a full card number?

**Catches:** A credential or secret-bearing object is written to logs or telemetry, where anyone with log access can read and replay it (CWE-532).

**Fix:** Log identifiers, not credentials: drop or mask tokens, passwords, auth headers and whole request bodies, or configure logger redaction (OWASP Logging Cheat Sheet; CWE-532).

**Bad** (`requestLogger.ts`):

```ts
export function requestLogger(req: Request, _res: Response, next: NextFunction) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, req.headers);
  next();
}
```

**Good** (`slack.ts`, looks similar but is fine):

```ts
const tokens = await exchangeCode(code);
  console.info("slack oauth complete", {
    teamId: tokens.team.id,
    scope: tokens.scope,
    tokenType: tokens.token_type,
    hasRefreshToken: Boolean(tokens.refresh_token),
    tokenSuffix: tokens.access_token.slice(-4),
  });
  return tokens;
```

**Not flagged:** Only non-secret fields are logged (user id, route, method, status, duration, error message); the secret is masked or reduced (`'[REDACTED]'`, last 4 chars, a hash/fingerprint, `hasToken: Boolean(token)`); token metadata is logged (`expiresAt`, `scope`, `kid`, token type); the logger is visibly configured to redact those paths (pino `redact: ['req.headers.authorization']`); the code is a test; or nothing secret is logged. Hardcoded literal secrets belong to ts-no-hardcoded-secret.

Holdout: precision 100%, recall 100% (6 violations in the holdout set).

### `ts-sec-cors-credentials`

Does the new code configure CORS so that every origin, or a loosely matched origin, is trusted with credentials -- `cors({ origin: true, credentials: true })`, an origin callback that always allows (`origin: (origin, cb) => cb(null, true)`, Hono `origin: (o) => o`) with `credentials: true`, `@fastify/cors`/NestJS `enableCors` with the same options, or setting `Access-Control-Allow-Origin` to the request's `Origin` header together with `Access-Control-Allow-Credentials: true` -- or decide whether an origin is trusted with a substring or unanchored check (`origin.endsWith('example.com')` without the leading dot, `origin.includes('example.com')`, `/example\.com/` without `^...$`)?

**Catches:** Any website (or a look-alike domain) can make credentialed cross-origin requests and read the responses with the victim's cookies (CWE-942).

**Fix:** Allow credentials only for an explicit list of origins compared exactly (parse and compare hostnames), never reflect arbitrary `Origin` (PortSwigger CORS; CWE-942; expressjs/cors docs).

**Bad** (`main.ts`):

```ts
app.enableCors({
    origin: (origin, callback) => {
      if (!origin || origin.endsWith("acme.com")) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  });
```

**Good** (`cors.ts`, looks similar but is fine):

```ts
import cors from "cors";
import type { Express } from "express";

export function configureCors(app: Express) {
  if (process.env.NODE_ENV === "development") {
    app.use(cors({ origin: true, credentials: true }));
    return;
  }
  app.use(cors({ origin: ["https://dashboard.example.com"], credentials: true }));
}
```

**Not flagged:** Origins come from a fixed list or env allow-list (`origin: ['https://app.example.com']`, `allowed.has(origin)`, `process.env.CORS_ORIGINS.split(',')`); the check is anchored (`/^https:\/\/([a-z0-9-]+\.)?example\.com$/`, `url.hostname === 'example.com' || url.hostname.endsWith('.example.com')`); a wildcard or reflected origin is used without credentials on a public, token-free API; the permissive config is inside a development-only branch or allows only `localhost`; or the code does not configure CORS.

Holdout: precision 100%, recall 80% (5 violations in the holdout set).

### `ts-sec-weak-password-hash`

Does the new code hash or store a user password (or a secret meant to be verified later) with a fast or unsalted digest — `crypto.createHash('md5'|'sha1'|'sha256'|'sha512')` or `crypto.subtle.digest(...)` of the password (with or without a static or concatenated salt), `md5(password)`/`sha256(password)` helpers, or storing it in plain text or reversible encoding (`btoa`, `Buffer.from(...).toString('base64')`, symmetric encryption) — instead of a password-hashing function?

**Catches:** A password is stored or verified using a fast general-purpose hash, a static salt, plain text, or reversible encoding.

**Why it matters:** Pearce et al. (IEEE S&P 2022) note Copilot repeatedly suggests fast hashes for passwords.

**Fix:** Hash passwords with argon2id, bcrypt or scrypt (Bun.password.hash / @node-rs/argon2) and verify with the library's constant-time check.

**Bad** (`legacy.ts`):

```ts
export async function verifyLegacy(user: LegacyUser, password: string) {
  const digest = createHash("md5").update(password).digest("hex");
  return digest === user.password_md5;
}

export async function upgradeHash(user: LegacyUser, password: string) {
  await db.users.update({ where: { id: user.id }, data: { password_md5: createHash("md5").update(password).digest("hex") } });
}
```

**Good** (`cache.ts`, looks similar but is fine):

```ts
export function cacheKey(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function etagFor(body: string) {
  return `"${createHash("sha1").update(body).digest("base64url")}"`;
}
```

**Not flagged:** Also fine: `argon2`/`@node-rs/argon2`, `bcrypt`/`bcryptjs`, `crypto.scrypt`/`scryptSync`, `crypto.pbkdf2` with a random salt and a high iteration count, `Bun.password.hash`, or an auth provider handling passwords; hashing non-password data (cache keys, ETags, file checksums, webhook HMAC signatures, content fingerprints, gravatar emails); or test code.

Holdout: precision 100%, recall 100% (5 violations in the holdout set). Sources: [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [cwe.mitre.org](https://cwe.mitre.org/data/definitions/916.html)
