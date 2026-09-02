# Invitation Codes and Bring-Your-Own API Design

## Goal

Add two access methods to the existing pet Meme generator:

1. An invitation code that spends quota from the site owner's configured model.
2. A user-supplied Gemini or Seedream API key that does not spend invitation quota.

The first public invitation codes use Seedream by default. The owner may explicitly create a Gemini invitation code, but invitation-code users cannot change the model assigned to their code.

## User Interface

The generation form starts with an access-method segmented control:

- `邀请码`: shows one invitation-code field, a verify button, the assigned model, and remaining successful generations.
- `使用自己的 API`: shows a Gemini/Seedream model selector and an API-key field.

`邀请码` is selected by default. Invitation-code users see the assigned model but cannot change it.

The API-key field uses password masking. Its value remains in page memory only, is never written to browser storage, and disappears when the page closes or reloads.

The existing template, pet-photo, adjustment, preview, result, and template-aspect-ratio flow remains unchanged.

## Invitation Code Rules

- Each code has a server-assigned provider and a remaining-use count.
- One successfully returned image spends one use.
- A regeneration from adjustment text spends another use.
- Validation failures do not reserve or spend quota.
- Before calling the image provider, the server atomically reserves one use.
- If the provider fails to return a valid image, the reservation is refunded.
- If the provider returns a valid image, the reservation becomes a completed use even if the browser disconnects before downloading it.
- A disabled, unknown, exhausted, or already-busy code is rejected with a clear Chinese message.
- A single invitation code may have only one generation in progress at a time in the MVP.

## Data Storage

Use SQLite in `.state/pet-meme.sqlite3`.

`invite_codes` stores:

- `id`
- `code_hash` (SHA-256; plaintext codes are never stored)
- `code_hint` (a short masked identifier for the owner list; it cannot be used to redeem the code)
- `provider` (`seedream` or `gemini`)
- `remaining_uses`
- `reserved_uses`
- `reserved_at` (nullable; used to recover interrupted reservations)
- `successful_uses`
- `enabled`
- `created_at`

`generation_events` stores:

- request ID and timestamp
- access method (`invite` or `own_api`)
- provider and model
- invitation-code ID when applicable, never the plaintext code
- status (`reserved`, `succeeded`, or `failed`)
- whether adjustment text was present
- template aspect ratio

Existing image output files remain under `.state/outputs`. Existing JSONL history is left intact and is not migrated.

## Server Flow

### Invitation Code

1. Validate uploads and provider-independent form fields.
2. Hash and look up the invitation code.
3. In one SQLite transaction, recover any reservation older than 10 minutes, then verify the code is enabled, has quota, and has no active reservation; decrement `remaining_uses`, increment `reserved_uses`, and set `reserved_at`.
4. Call the provider assigned to the code using the owner's environment-variable API key.
5. On success, decrement `reserved_uses`, clear `reserved_at`, increment `successful_uses`, save the image, and record success.
6. On provider failure, decrement `reserved_uses`, clear `reserved_at`, restore `remaining_uses`, and record failure.

A reservation older than 10 minutes is treated as an interrupted request and refunded before the next verify or generation attempt. This exceeds the provider request timeout and prevents a service restart from leaving a code permanently busy.

### User-Supplied API

1. Validate provider and API key presence.
2. Construct a request-scoped provider client with that key.
3. Generate and save the image through the existing flow.
4. Record provider, model, and status without recording the key.

The API key is not placed in URLs, exception messages, output metadata, or application logs.

The current MVP is local. Before a public deployment, the site must use HTTPS so a user-supplied API key is encrypted in transit.

## Endpoints

- `POST /api/invite/verify`: returns validity, assigned provider, and remaining uses.
- `POST /api/generate`: accepts `access_method`, invitation code or own API key, provider, uploads, adjustment, and template dimensions.
- `POST /api/admin/invites`: creates a code with provider and quota.
- `GET /api/admin/invites`: lists masked code identifiers, provider, usage, and status.
- `POST /api/admin/invites/<id>/toggle`: enables or disables a code.

Admin endpoints require an `ADMIN_PASSWORD` supplied in a request header. The owner page stores it only in page memory. If `ADMIN_PASSWORD` is absent, all admin endpoints remain disabled. The MVP does not add user accounts, payments, password recovery, or role management.

## Owner Page

Add `/admin.html` as a quiet local management page. It supports creating invitation codes, copying the newly created plaintext code once, listing usage, and pausing or resuming codes. Existing plaintext codes cannot be recovered later because only hashes are stored.

## Error Handling

- Missing or invalid credentials produce provider-specific Chinese messages.
- Exhausted invitation codes show zero remaining uses without calling a provider.
- Provider failures refund reserved quota.
- Database errors fail closed and do not call a provider.
- API keys and full invitation codes are redacted from all errors and logs.

## Verification

Automated tests cover:

- invitation creation, hashing, verification, and masking
- successful quota reservation and completion
- provider failure refund
- stale-reservation recovery after an interrupted request
- exhausted, disabled, unknown, and concurrent-use rejection
- provider assignment cannot be overridden by invitation users
- user-supplied Gemini and Seedream routing without quota changes
- API keys absent from SQLite, JSONL, errors, and responses
- existing aspect-ratio behavior for both providers
- UI presence and conditional fields

Manual verification covers one successful invitation-code generation, one user-supplied-key generation, refresh behavior, and desktop/mobile layout.

## Out of Scope

- Payment processing
- User registration or login
- Community or public gallery
- Multi-animal templates
- Complex image editing
- Invitation transfers, expiration dates, or per-user ownership
- Production deployment and distributed quota storage
