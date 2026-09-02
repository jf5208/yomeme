# Invitation Codes and Bring-Your-Own API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add quota-backed invitation codes, request-scoped Gemini and Seedream API keys, and a small owner management page to the existing pet Meme generator.

**Architecture:** A focused SQLite store owns invitation-code hashing, quota reservation, stale-request recovery, and generation audit events. Flask resolves each generation request to either an owner-configured generator selected by the invitation code or a request-scoped generator created from the user's API key; the browser never persists credentials. The existing upload, prompt, template-ratio, output, and adjustment workflow remains the shared generation path.

**Tech Stack:** Python 3.13, Flask 3.1, standard-library `sqlite3`, Requests, vanilla HTML/CSS/JavaScript, pytest.

**Spec:** `docs/superpowers/specs/2026-09-02-invite-code-byok-design.md`

## Global Constraints

- `邀请码` is the default access method.
- Invitation codes default to `seedream`; the owner may explicitly create a `gemini` code.
- Invitation users cannot override the provider assigned to their code.
- One valid returned image consumes one use; adjustment regeneration consumes another use.
- Validation and provider failures consume no use; provider calls reserve one use atomically and refund on failure.
- One invitation code may have only one generation in progress.
- Reservations older than 10 minutes are failed and refunded before verify or reserve.
- User-supplied keys live only in request/page memory and must never appear in SQLite, JSONL, URLs, responses, exceptions, or browser storage.
- `ADMIN_PASSWORD` is sent as `X-Admin-Password`; absent server configuration disables all admin endpoints.
- Public deployment with user-supplied keys requires HTTPS; this implementation remains a local MVP.
- Existing output files and JSONL history remain in place; old JSONL rows are not migrated.
- Preserve the existing template-derived aspect ratio for Gemini and Seedream.
- The app directory is not currently a Git repository, so implementation checkpoints are verified with tests instead of commits.

## File Structure

- Create `pet_meme/invites.py`: SQLite schema, code creation/hash/masking, quota lifecycle, stale reservation recovery, and audit rows.
- Modify `pet_meme/generator.py`: expose one provider factory that creates request-scoped generators without retaining user keys globally.
- Modify `pet_meme/app.py`: access-mode resolution, invite verification, admin authentication/endpoints, secure error handling, and shared generation flow.
- Modify `static/index.html`: invitation/BYOK segmented control and conditional credential fields.
- Modify `static/app.js`: access-mode state, invite verification, BYOK submission, provider/result status, and no browser credential persistence.
- Modify `static/styles.css`: compact access controls, credential status, owner table, and responsive layout.
- Create `static/admin.html`: owner-only invitation management surface.
- Create `static/admin.js`: page-memory password, invitation creation/list/toggle, and one-time copy action.
- Create `tests/test_invites.py`: store-level quota, masking, concurrency, and stale reservation tests.
- Modify `tests/test_generator.py`: provider-factory coverage.
- Modify `tests/test_app.py`: route, quota, BYOK, redaction, admin, and static UI coverage.
- Modify `.env.example`: document `ADMIN_PASSWORD` without adding a real secret.
- Modify `README.md`: explain the two access methods and local owner workflow.

---

### Task 1: Invitation Store and Atomic Quota Lifecycle

**Files:**
- Create: `pet_meme/invites.py`
- Create: `tests/test_invites.py`

**Interfaces:**
- Produces: `InviteCodeError(code: str, message: str)`.
- Produces: `CreatedInvite(id: int, plaintext_code: str, code_hint: str, provider: str, remaining_uses: int, enabled: bool)`.
- Produces: `InviteStatus(id: int, code_hint: str, provider: str, remaining_uses: int, reserved_uses: int, successful_uses: int, enabled: bool)`.
- Produces: `InviteStore(database_path: Path, now: Callable[[], datetime] | None = None)`.
- Produces: `InviteStore.create_invite(provider: str = "seedream", uses: int = 1) -> CreatedInvite`.
- Produces: `InviteStore.verify(code: str) -> InviteStatus`.
- Produces: `InviteStore.reserve(code: str, request_id: str, model: str, has_adjustment: bool, aspect_ratio: str) -> InviteStatus`.
- Produces: `InviteStore.complete(request_id: str) -> InviteStatus` and `InviteStore.refund(request_id: str) -> InviteStatus`.
- Produces: `InviteStore.record_own_api(request_id: str, provider: str, model: str, status: str, has_adjustment: bool, aspect_ratio: str) -> None`.
- Produces: `InviteStore.list_invites() -> list[InviteStatus]` and `InviteStore.set_enabled(invite_id: int, enabled: bool) -> InviteStatus`.

- [ ] **Step 1: Write creation and verification tests**

```python
def test_create_invite_stores_hash_and_returns_plaintext_once(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    created = store.create_invite(provider="seedream", uses=3)

    assert created.plaintext_code
    assert created.code_hint.startswith(created.plaintext_code[:4])
    assert store.verify(created.plaintext_code).remaining_uses == 3

    with sqlite3.connect(tmp_path / "pet-meme.sqlite3") as connection:
        row = connection.execute("SELECT code_hash, code_hint FROM invite_codes").fetchone()
    assert created.plaintext_code not in row
    assert row[0] == hashlib.sha256(created.plaintext_code.encode()).hexdigest()


@pytest.mark.parametrize("provider", ["gemini", "seedream"])
def test_create_invite_accepts_supported_provider(tmp_path, provider):
    created = InviteStore(tmp_path / "pet-meme.sqlite3").create_invite(provider, 2)
    assert created.provider == provider
```

- [ ] **Step 2: Run the creation tests and confirm the import fails because `pet_meme.invites` does not exist**

Run: `.venv/bin/python -m pytest tests/test_invites.py -q`

Expected: collection fails with `ModuleNotFoundError: No module named 'pet_meme.invites'`.

- [ ] **Step 3: Implement schema initialization, secure random creation, SHA-256 lookup, masked hints, and input validation**

```python
class InviteCodeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class InviteStore:
    def __init__(self, database_path: Path, now=None):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.now = now or (lambda: datetime.now(timezone.utc))
        self._initialize()

    def create_invite(self, provider="seedream", uses=1):
        if provider not in {"gemini", "seedream"}:
            raise InviteCodeError("invalid_provider", "请选择 Gemini 或 Seedream。")
        if not isinstance(uses, int) or uses < 1:
            raise InviteCodeError("invalid_uses", "使用次数必须是大于 0 的整数。")
        plaintext = secrets.token_urlsafe(18)
        digest = hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
        hint = f"{plaintext[:4]}...{plaintext[-4:]}"
        created_at = self.now().isoformat()
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO invite_codes "
                "(code_hash, code_hint, provider, remaining_uses, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (digest, hint, provider, uses, created_at),
            )
        return CreatedInvite(cursor.lastrowid, plaintext, hint, provider, uses, True)
```

Schema requirements:

```sql
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'seedream')),
  remaining_uses INTEGER NOT NULL,
  reserved_uses INTEGER NOT NULL DEFAULT 0,
  reserved_at TEXT,
  successful_uses INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generation_events (
  request_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  access_method TEXT NOT NULL CHECK (access_method IN ('invite', 'own_api')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  invite_code_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed')),
  has_adjustment INTEGER NOT NULL,
  aspect_ratio TEXT NOT NULL,
  FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id)
);
```

- [ ] **Step 4: Run store creation tests and confirm they pass**

Run: `.venv/bin/python -m pytest tests/test_invites.py -q`

Expected: all current `tests/test_invites.py` tests pass.

- [ ] **Step 5: Write failing tests for reserve, completion, refund, busy/exhausted/disabled/unknown rejection, and stale recovery**

```python
def test_complete_consumes_one_reserved_use(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("seedream", 2).plaintext_code
    store.reserve(code, "req-1", "seedream-model", False, "1:1")
    status = store.complete("req-1")
    assert (status.remaining_uses, status.reserved_uses, status.successful_uses) == (1, 0, 1)


def test_refund_restores_reserved_use(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("gemini", 1).plaintext_code
    store.reserve(code, "req-1", "gemini-model", True, "4:5")
    status = store.refund("req-1")
    assert (status.remaining_uses, status.reserved_uses, status.successful_uses) == (1, 0, 0)


def test_second_reservation_is_rejected_while_first_is_active(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("seedream", 2).plaintext_code
    store.reserve(code, "req-1", "model", False, "1:1")
    with pytest.raises(InviteCodeError, match="正在生成"):
        store.reserve(code, "req-2", "model", False, "1:1")


def test_stale_reservation_is_refunded_before_verify(tmp_path):
    clock = MutableClock(datetime(2026, 9, 2, tzinfo=timezone.utc))
    store = InviteStore(tmp_path / "pet-meme.sqlite3", now=clock.now)
    code = store.create_invite("seedream", 1).plaintext_code
    store.reserve(code, "req-1", "model", False, "1:1")
    clock.advance(minutes=11)
    status = store.verify(code)
    assert (status.remaining_uses, status.reserved_uses) == (1, 0)


def test_unknown_disabled_and_exhausted_codes_have_distinct_errors(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    with pytest.raises(InviteCodeError, match="邀请码无效"):
        store.verify("not-a-code")

    disabled = store.create_invite("seedream", 1)
    store.set_enabled(disabled.id, False)
    with pytest.raises(InviteCodeError, match="暂停"):
        store.verify(disabled.plaintext_code)

    exhausted = store.create_invite("seedream", 1)
    store.reserve(exhausted.plaintext_code, "req-2", "model", False, "1:1")
    store.complete("req-2")
    with pytest.raises(InviteCodeError, match="剩余次数为 0"):
        store.verify(exhausted.plaintext_code)


def test_generation_event_moves_from_reserved_to_failed_on_refund(tmp_path):
    store = InviteStore(tmp_path / "pet-meme.sqlite3")
    code = store.create_invite("seedream", 1).plaintext_code
    store.reserve(code, "req-3", "model", False, "1:1")
    store.refund("req-3")
    with sqlite3.connect(tmp_path / "pet-meme.sqlite3") as connection:
        status = connection.execute(
            "SELECT status FROM generation_events WHERE request_id = 'req-3'"
        ).fetchone()[0]
    assert status == "failed"
```

- [ ] **Step 6: Run quota tests and confirm they fail because lifecycle methods are absent**

Run: `.venv/bin/python -m pytest tests/test_invites.py -q`

Expected: failures identify missing `reserve`, `complete`, `refund`, `list_invites`, or `set_enabled` behavior.

- [ ] **Step 7: Implement quota methods with `BEGIN IMMEDIATE` transactions**

```python
def reserve(self, code, request_id, model, has_adjustment, aspect_ratio):
    with self._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = self._lookup_and_recover(connection, code)
        if not row["enabled"]:
            raise InviteCodeError("disabled", "这个邀请码已暂停使用。")
        if row["reserved_uses"]:
            raise InviteCodeError("busy", "这个邀请码正在生成，请完成后再试。")
        if row["remaining_uses"] < 1:
            raise InviteCodeError("exhausted", "这个邀请码的剩余次数为 0。")
        connection.execute(
            "UPDATE invite_codes SET remaining_uses = remaining_uses - 1, "
            "reserved_uses = 1, reserved_at = ? WHERE id = ?",
            (self.now().isoformat(), row["id"]),
        )
        connection.execute(
            "INSERT INTO generation_events VALUES (?, ?, 'invite', ?, ?, ?, 'reserved', ?, ?)",
            (request_id, self.now().isoformat(), row["provider"], model, row["id"], int(has_adjustment), aspect_ratio),
        )
        return self._status_by_id(connection, row["id"])
```

`complete` changes only a matching `reserved` event, clears the reservation, and increments `successful_uses`. `refund` changes only a matching `reserved` event, clears the reservation, and restores `remaining_uses`. `_lookup_and_recover` marks reservations older than `timedelta(minutes=10)` failed before returning status.

- [ ] **Step 8: Run the full store suite**

Run: `.venv/bin/python -m pytest tests/test_invites.py -q`

Expected: all store tests pass with no warnings.

---

### Task 2: Request-Scoped Generators and Generation Access Routing

**Files:**
- Modify: `pet_meme/generator.py`
- Modify: `pet_meme/app.py`
- Modify: `tests/test_generator.py`
- Modify: `tests/test_app.py`

**Interfaces:**
- Consumes: `InviteStore.verify`, `reserve`, `complete`, `refund`, and `record_own_api` from Task 1.
- Produces: `create_image_generator(provider: str, api_key: str, seedream_model: str | None = None, session=None)`.
- Produces: `create_app(state_dir: Path | None = None, generator=None, generators=None, generator_factories: dict[str, Callable[[str], object]] | None = None) -> Flask` for tests and request-scoped BYOK clients.
- Produces: `POST /api/invite/verify` accepting JSON `{"code": "invite-code"}`.
- Extends: `POST /api/generate` with `access_method=invite|own_api`, `invite_code`, and `api_key`.

- [ ] **Step 1: Write a failing provider-factory test**

```python
@pytest.mark.parametrize(
    ("provider", "expected_type"),
    [("gemini", GeminiImageGenerator), ("seedream", SeedreamImageGenerator)],
)
def test_create_image_generator_uses_request_key(provider, expected_type):
    generator = create_image_generator(provider, "request-key", seedream_model="seedream-test")
    assert isinstance(generator, expected_type)
    assert generator.api_key == "request-key"
```

- [ ] **Step 2: Run the factory test and confirm it fails on the missing symbol**

Run: `.venv/bin/python -m pytest tests/test_generator.py -q`

Expected: import failure for `create_image_generator`.

- [ ] **Step 3: Add the minimal provider factory**

```python
def create_image_generator(provider, api_key, seedream_model=None, session=None):
    if provider == "gemini":
        return GeminiImageGenerator(api_key, session=session)
    if provider == "seedream":
        return SeedreamImageGenerator(api_key, session=session, model_name=seedream_model)
    raise ValueError("Unsupported image provider")
```

- [ ] **Step 4: Run generator tests and confirm they pass**

Run: `.venv/bin/python -m pytest tests/test_generator.py -q`

Expected: all generator tests pass.

- [ ] **Step 5: Write failing Flask tests for invite verification, assigned-provider routing, BYOK routing, quota completion/refund, and credential redaction**

```python
def test_invite_generation_uses_assigned_provider_and_spends_one(tmp_path):
    gemini = StubGenerator(model_name="gemini-owner")
    seedream = StubGenerator(model_name="seedream-owner")
    app = create_app(state_dir=tmp_path, generators={"gemini": gemini, "seedream": seedream})
    code = app.extensions["invite_store"].create_invite("seedream", 2).plaintext_code

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": code,
            "provider": "gemini",
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    assert response.get_json()["provider"] == "seedream"
    assert response.get_json()["remaining_uses"] == 1
    assert not gemini.calls
    assert len(seedream.calls) == 1
    assert app.extensions["invite_store"].verify(code).remaining_uses == 1


def test_own_api_builds_request_scoped_generator_without_spending_invite_quota(tmp_path):
    captured = {}
    own_generator = StubGenerator(model_name="gemini-own")
    app = create_app(
        state_dir=tmp_path,
        generators={"gemini": StubGenerator(), "seedream": StubGenerator()},
        generator_factories={"gemini": lambda key: captured.update(key=key) or own_generator},
    )
    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "own_api",
            "provider": "gemini",
            "api_key": "private-test-key",
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert captured == {"key": "private-test-key"}
    assert "private-test-key" not in (tmp_path / "generations.jsonl").read_text()
    assert "private-test-key" not in (tmp_path / "pet-meme.sqlite3").read_bytes().decode("utf-8", errors="ignore")


def test_upload_validation_does_not_reserve_invite_quota(tmp_path):
    app = create_app(state_dir=tmp_path, generators={"gemini": StubGenerator(), "seedream": StubGenerator()})
    store = app.extensions["invite_store"]
    code = store.create_invite("seedream", 1).plaintext_code
    response = app.test_client().post(
        "/api/generate",
        data={"access_method": "invite", "invite_code": code, "pets": [make_upload("pet.png")]},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert store.verify(code).remaining_uses == 1
```

```python
class ErrorGenerator:
    model_name = "error-model"

    def __init__(self, message="provider failed"):
        self.message = message

    def generate(self, *args, **kwargs):
        raise ImageGenerationError(self.message)


def test_own_api_key_is_redacted_from_provider_error_and_storage(tmp_path, caplog):
    key = "private-test-key"
    app = create_app(
        state_dir=tmp_path,
        generators={"gemini": StubGenerator(), "seedream": StubGenerator()},
        generator_factories={"gemini": lambda supplied: ErrorGenerator(f"provider failed: {supplied}")},
    )
    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "own_api",
            "provider": "gemini",
            "api_key": key,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 502
    assert key not in response.get_data(as_text=True)
    assert "【已隐藏】" in response.get_data(as_text=True)
    assert key not in (tmp_path / "generations.jsonl").read_text()
    assert key not in caplog.text


def test_failed_invite_generation_refunds_the_reserved_use(tmp_path):
    failing = ErrorGenerator()
    app = create_app(
        state_dir=tmp_path,
        generators={"gemini": StubGenerator(), "seedream": failing},
    )
    store = app.extensions["invite_store"]
    code = store.create_invite("seedream", 1).plaintext_code
    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 502
    assert store.verify(code).remaining_uses == 1
```

- [ ] **Step 6: Run the new Flask tests and confirm access routing is absent**

Run: `.venv/bin/python -m pytest tests/test_app.py -q`

Expected: failures show missing invite route, missing app extension, and no request-scoped factory call.

- [ ] **Step 7: Refactor `generate` into validation, access resolution, provider call, and finalization phases**

```python
access_method = request.form.get("access_method", "invite")
if access_method == "invite":
    invite_code = request.form.get("invite_code", "").strip()
    invite_status = invite_store.verify(invite_code)
    provider = invite_status.provider
    image_generator = owner_generators.get(provider)
    if image_generator is None:
        return jsonify(ok=False, error="这个邀请码对应的模型暂不可用。"), 503
    invite_store.reserve(invite_code, request_id, image_generator.model_name, bool(adjustment.strip()), aspect_ratio)
else:
    api_key = request.form.get("api_key", "").strip()
    provider = request.form.get("provider", "")
    image_generator = generator_factories[provider](api_key)
```

Catch `InviteCodeError` as a 400 response before a provider call. After reservation, wrap the provider call so `ImageGenerationError` triggers `invite_store.refund(request_id)` and BYOK failure writes a failed event. On success, save output first, then call `complete`; return the updated `remaining_uses` for invitation requests. If output writing fails, refund and return a generic Chinese error. JSONL records gain `access_method` and invitation records use only the database ID, never the code. Sanitize all user-facing errors with `message.replace(api_key, "【已隐藏】")` when a BYOK key exists.

- [ ] **Step 8: Add `/api/invite/verify` and expose the store for tests**

```python
app.extensions["invite_store"] = invite_store

@app.post("/api/invite/verify")
def verify_invite():
    try:
        status = invite_store.verify((request.get_json(silent=True) or {}).get("code", ""))
    except InviteCodeError as error:
        return jsonify(ok=False, error=str(error)), 400
    return jsonify(ok=True, provider=status.provider, remaining_uses=status.remaining_uses)
```

- [ ] **Step 9: Run app and full Python tests**

Run: `.venv/bin/python -m pytest tests/test_app.py tests/test_generator.py tests/test_invites.py -q`

Expected: all listed tests pass and existing ratio tests remain green.

---

### Task 3: Password-Protected Owner API

**Files:**
- Modify: `pet_meme/app.py`
- Modify: `tests/test_app.py`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `InviteStore.create_invite`, `list_invites`, and `set_enabled` from Task 1.
- Produces: `POST /api/admin/invites` with JSON `{"provider": "seedream", "uses": 10}`.
- Produces: `GET /api/admin/invites` returning masked identifiers and usage only.
- Produces: `POST /api/admin/invites/<int:invite_id>/toggle` with JSON `{"enabled": false}`.
- Produces: `X-Admin-Password` constant-time comparison against `ADMIN_PASSWORD`.

- [ ] **Step 1: Write failing admin authentication and CRUD tests**

```python
def test_admin_routes_are_disabled_without_server_password(tmp_path, monkeypatch):
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    app = create_app(state_dir=tmp_path, generators=stub_generators())
    response = app.test_client().get("/api/admin/invites", headers={"X-Admin-Password": "anything"})
    assert response.status_code == 503


def test_admin_can_create_list_and_disable_invite(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "owner-secret")
    app = create_app(state_dir=tmp_path, generators=stub_generators())
    client = app.test_client()
    headers = {"X-Admin-Password": "owner-secret"}

    created = client.post(
        "/api/admin/invites",
        json={"provider": "seedream", "uses": 5},
        headers=headers,
    ).get_json()
    assert created["plaintext_code"]

    listed = client.get("/api/admin/invites", headers=headers).get_json()["invites"]
    assert listed[0]["code_hint"] in created["plaintext_code"].replace(created["plaintext_code"][4:-4], "...")
    assert "plaintext_code" not in listed[0]

    toggled = client.post(
        f"/api/admin/invites/{listed[0]['id']}/toggle",
        json={"enabled": False},
        headers=headers,
    )
    assert toggled.get_json()["enabled"] is False
```

Also assert missing or wrong headers return 401 and that `provider` defaults to `seedream` when omitted.

- [ ] **Step 2: Run admin tests and confirm all three endpoints are missing**

Run: `.venv/bin/python -m pytest tests/test_app.py -q`

Expected: admin route requests return 404.

- [ ] **Step 3: Implement fail-closed admin authentication and endpoint serialization**

```python
def require_admin(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        configured = os.environ.get("ADMIN_PASSWORD", "")
        if not configured:
            return jsonify(ok=False, error="管理功能尚未启用。"), 503
        supplied = request.headers.get("X-Admin-Password", "")
        if not hmac.compare_digest(supplied, configured):
            return jsonify(ok=False, error="管理密码不正确。"), 401
        return view(*args, **kwargs)
    return wrapped
```

Return the plaintext code only from the successful create response. List and toggle responses use `id`, `code_hint`, `provider`, `remaining_uses`, `reserved_uses`, `successful_uses`, and `enabled`.

- [ ] **Step 4: Add the empty environment variable**

```dotenv
ADMIN_PASSWORD=
```

- [ ] **Step 5: Run app and store suites**

Run: `.venv/bin/python -m pytest tests/test_app.py tests/test_invites.py -q`

Expected: all tests pass.

---

### Task 4: User Access Controls and Owner Page

**Files:**
- Modify: `static/index.html`
- Modify: `static/app.js`
- Modify: `static/styles.css`
- Create: `static/admin.html`
- Create: `static/admin.js`
- Modify: `tests/test_app.py`

**Interfaces:**
- Consumes: `/api/invite/verify`, `/api/generate`, and `/api/admin/invites*` from Tasks 2 and 3.
- Produces DOM IDs: `access-invite`, `access-own-api`, `invite-fields`, `invite-code`, `verify-invite`, `invite-status`, `own-api-fields`, `api-key`, and existing generation IDs.
- Produces admin DOM IDs: `admin-password`, `invite-provider`, `invite-uses`, `create-invite`, `created-code`, `copy-created-code`, `invite-list`, and `admin-status`.

- [ ] **Step 1: Replace the existing model-only HTML test with failing access-mode and owner-page assertions**

```python
def test_index_offers_invite_and_own_api_without_persisting_credentials(tmp_path):
    app = create_app(state_dir=tmp_path, generators=stub_generators())
    html = app.test_client().get("/").get_data(as_text=True)
    script = app.test_client().get("/app.js").get_data(as_text=True)
    assert 'name="access_method" value="invite" checked' in html
    assert 'name="access_method" value="own_api"' in html
    assert 'id="invite-code"' in html
    assert 'id="api-key" type="password"' in html
    assert 'name="provider" value="gemini"' in html
    assert 'name="provider" value="seedream"' in html
    assert "localStorage" not in script
    assert "sessionStorage" not in script


def test_admin_page_contains_creation_and_usage_controls(tmp_path):
    app = create_app(state_dir=tmp_path, generators=stub_generators())
    html = app.test_client().get("/admin.html").get_data(as_text=True)
    assert 'id="admin-password"' in html
    assert 'id="invite-provider"' in html
    assert 'id="invite-uses"' in html
    assert 'id="invite-list"' in html
```

- [ ] **Step 2: Run the UI tests and confirm the new controls are absent**

Run: `.venv/bin/python -m pytest tests/test_app.py -q`

Expected: assertions fail on missing access and admin IDs.

- [ ] **Step 3: Implement the main-page access controls**

```html
<fieldset class="access-picker">
  <legend>使用方式</legend>
  <label><input id="access-invite" type="radio" name="access_method" value="invite" checked /><span>邀请码</span></label>
  <label><input id="access-own-api" type="radio" name="access_method" value="own_api" /><span>使用自己的 API</span></label>
</fieldset>
<section id="invite-fields" class="credential-fields">
  <label>邀请码<input id="invite-code" name="invite_code" autocomplete="off" /></label>
  <button id="verify-invite" class="secondary-button" type="button">验证邀请码</button>
  <p id="invite-status" class="inline-status" role="status"></p>
</section>
<section id="own-api-fields" class="credential-fields" hidden>
  <fieldset class="model-picker">
    <legend>生成模型</legend>
    <label><input type="radio" name="provider" value="gemini" checked /><span>Gemini</span></label>
    <label><input type="radio" name="provider" value="seedream" /><span>Seedream</span></label>
  </fieldset>
  <label>API Key<input id="api-key" name="api_key" type="password" autocomplete="off" /></label>
</section>
```

Keep the current model labels, uploads, preservation checklist, adjustment field, hidden template dimensions, and previews.

- [ ] **Step 4: Implement page-memory state and submission behavior**

```javascript
function syncAccessMode() {
  const ownApi = document.querySelector('input[name="access_method"]:checked').value === "own_api";
  inviteFields.hidden = ownApi;
  ownApiFields.hidden = !ownApi;
}

verifyInviteButton.addEventListener("click", async () => {
  const response = await fetch("/api/invite/verify", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({code: inviteCode.value}),
  });
  const payload = await response.json();
  inviteStatus.textContent = response.ok
    ? `${payload.provider === "seedream" ? "Seedream" : "Gemini"} · 剩余 ${payload.remaining_uses} 次`
    : payload.error;
});
```

Before generation, require a nonempty invitation code or BYOK key for the selected mode. Derive the progress/success model name from the verified invite response or selected BYOK provider. After an invitation success, update the displayed remaining count from the generation response. Do not use `localStorage`, `sessionStorage`, query parameters, or cookies.

- [ ] **Step 5: Implement the owner page and one-time plaintext display**

```javascript
function adminHeaders() {
  return {"Content-Type": "application/json", "X-Admin-Password": adminPassword.value};
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/admin/invites", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({provider: inviteProvider.value, uses: Number(inviteUses.value)}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  createdCode.textContent = payload.plaintext_code;
  await loadInvites();
});
```

The list uses a semantic table on wide screens and horizontally scrolls on narrow screens. Each row shows masked code, model, remaining/successful counts, state, and a pause/resume button. Copy uses `navigator.clipboard.writeText(createdCode.textContent)` and never stores the value elsewhere.

- [ ] **Step 6: Add compact responsive styling**

Use the existing green, white, gray, and brown palette; 6px radii; native form controls; no nested cards. At `max-width: 920px`, keep the current one-column workspace and make both segmented controls and credential actions fit without horizontal overflow. At `max-width: 520px`, stack credential input and action button while keeping minimum 44px touch targets.

- [ ] **Step 7: Run static UI and full Python tests**

Run: `.venv/bin/python -m pytest tests -q`

Expected: all tests pass.

---

### Task 5: Documentation and Browser Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: completed user and owner flows from Tasks 1-4.
- Produces: local setup instructions for `GEMINI_API_KEY`, `ARK_API_KEY`, `SEEDREAM_MODEL`, and `ADMIN_PASSWORD`.

- [ ] **Step 1: Update the README to match implemented behavior**

Document:

```text
用户入口：http://127.0.0.1:18806/
邀请码管理：http://127.0.0.1:18806/admin.html

邀请码成功生成一张图片扣一次；生成失败自动退回。
使用自己的 API 时，Key 只随当前生成请求发送，不保存在浏览器或服务端。
```

Replace the old statement that the MVP has no quota system. State that payment, accounts, and public deployment remain outside the MVP.

- [ ] **Step 2: Run the complete automated suite**

Run: `.venv/bin/python -m pytest tests -q`

Expected: every test passes with no failures or warnings.

- [ ] **Step 3: Restart the local server and verify health without printing secrets**

Run: `.venv/bin/python run.py`

Expected: Flask listens on `http://127.0.0.1:18806`; `/api/health` reports provider configuration booleans only.

- [ ] **Step 4: Verify the owner workflow in the in-app browser**

Open `http://127.0.0.1:18806/admin.html`, enter the configured admin password, create a 2-use Seedream code, copy it, confirm the list shows only its masked hint, pause/resume it, and confirm the status updates without a page reload.

- [ ] **Step 5: Verify invitation and BYOK workflows**

On the main page, verify the created code and confirm its assigned model and remaining count. Run one real invitation generation and confirm remaining uses decreases by one. Then switch to own API, enter a test key for one configured provider, generate once, refresh the page, and confirm the key field is empty.

- [ ] **Step 6: Verify desktop and mobile layout**

Capture browser screenshots at 1440x900 and 390x844. Confirm that the access selector, credential fields, uploads, submit button, previews, owner table, and pause/resume controls do not overlap or overflow, and that generated images remain contained at the template-derived aspect ratio.

- [ ] **Step 7: Inspect persisted data for secret leakage**

Run: `rg -n --hidden --glob '!*.jpg' --glob '!*.png' '<test-key-used-for-manual-check>' .state`

Expected: no matches. Inspect one invitation row and generation event through a read-only SQLite query and confirm quota/status values match the browser results while no plaintext code or API key is present.
