# Private beta feedback (OS-07)

This opt-in local adapter stores feedback that a reader deliberately submits through the website. It does not send email, create public issues, require a GitHub account, invoke a model or notify an external service. A saved receipt acknowledges storage, not a promised email response.

## Availability and API

`PROCESSING_FEEDBACK_ENABLED=false` by default. Enabling it requires `PROCESSING_ENABLED=true` and `PROCESSING_REPOSITORY=local`. Existing processing-access rules still apply: loopback development or the configured HTTPS public beta with its dedicated directory. MySQL feedback is not implemented. No database migration is needed.

`GET /api/v1/capabilities` adds `feedbackAvailable: boolean` and `feedbackRetentionHours: 24 | null`. Older services may omit these fields; clients should treat that as unavailable. A configured and initialized local store is required before enabled service startup completes. Runtime storage failures return a safe error rather than a false saved receipt. File/book upload limits and processing capabilities keep their existing meaning.

`POST /api/v1/feedback` uses the normal response envelope and requires an `Idempotency-Key` UUID. The strict JSON input is:

| Field                    | Accepted values                                                                  |
| ------------------------ | -------------------------------------------------------------------------------- |
| `category`               | `typography`, `processing`, `download`, `other`                                  |
| `reader`                 | `kindle`, `apple-books`, `kobo`, `calibre`, `other`, `not-tested`                |
| `deliveryRoute`          | `send-to-kindle`, `usb`, `reader-import`, `not-tested`, `other`                  |
| `rating` (optional)      | `better`, `same`, `worse`                                                        |
| `requestId` (optional)   | 1–128 ASCII letters, digits, `.`, `_` or `-`, deliberately entered by the reader |
| `description` (optional) | Trimmed text, at most 1,000 UTF-16 code units                                    |

The route has an 8 KiB JSON-parser limit; malformed/oversized input uses the existing safe API errors. Unknown fields, including automatically attached book/task metadata, URLs, file attachments and cookies, are rejected. Successful creation and an identical replay return HTTP 201 with `{ data: { receiptId, expiresAt }, meta: { requestId } }`. A changed normalized payload with the same owner/key returns `IDEMPOTENCY_CONFLICT` (409).

Public-beta mutations retain the exact HTTPS host, proxy, Origin and same-site checks. Cookies are transmitted for normal access/session control, but their raw values are not copied into feedback records. There is no public feedback list, receipt lookup or download route; another anonymous session cannot query or replay a prior session's receipt. The receipt URL is not a new access capability.

## Data, quotas and retention

Only the selected fields and private operational metadata are persisted. The application does not automatically attach book text, book/file names, current page URL, task data, IP, user agent, raw Cookie, headers, credentials or model prompts. Optional text is user-provided and could contain information the reader chooses to paste; the interface should ask them to avoid book text, contact details and secrets. This is not a claim that arbitrary pasted text has been automatically scrubbed.

`PROCESSING_DATA_DIR/feedback/state.json` is separate from the book metadata and artifact directories. It records receipt/creation/expiry, a second-hashed feedback owner scope, owner-scoped idempotency hash, normalized payload hash and the chosen payload. It stores neither the raw session token nor the raw idempotency header. Owner scope is distinct from the book repository owner ID.

- At most five accepted records per anonymous owner within the rolling 24-hour retention window.
- At most 500 unexpired records globally, with a 4 MiB state-size ceiling.
- Duplicate replay is checked before quotas or storage-capacity admission, so a lost response can be confirmed at capacity.
- New writes still run the existing beta storage-capacity admission. Its data-directory walk includes feedback, temporary and lock files; this does not bypass the beta storage guard or turn its conservative estimate into a filesystem quota.
- The normal HTTP throttle also applies. Anonymous cookies are not stable person identities, and changing cookies can bypass the owner count; the global record/body/storage limits remain bounded.

Every accepted record expires exactly 24 hours after creation. Under the same OS lock, submissions, private operator reads and cleanup discard expired records. A 30-second running-service sweep atomically persists deletion. Turning off feedback or processing still cleans an existing recognized feedback store when its valid local data directory remains configured; it does not create a new store merely to advertise a disabled feature. Cleanup failures emit only the safe `feedback_cleanup_unavailable` event, and operators should restore storage access. A stopped or disconnected host cannot run cleanup; startup/next operator read sweeps before exposing records.

Coordination uses the existing SQLite OS-lock helper in a separate `feedback/state.lock.sqlite`, and the same atomic rename helper, 0600 write files, fsync and POSIX directory fsync. The SQLite file holds locks, not feedback data. Concurrent API/Worker processes serialize expiry, deduplication and quota decisions. Crashed write temporaries are removed under that lock using fixed generated names; live lock files, source books, old private datasets and metadata markers are not removed. Unknown/corrupt/oversized feedback state fails safely rather than being reset.

## Private operator inspection

After building, run as the service account on its host:

```sh
node scripts/read-feedback.mjs --data-dir /var/lib/epub-ai/data --limit 50
```

This reads/prunes only the private feedback store and prints receipt timestamps plus deliberately submitted fields. It does not open network connections or show the owner/key hashes. Keep this output out of public logs/issues; no background process prints feedback contents. There is no web administration endpoint in this change.

Tests cover real HTTP Origin/owner boundaries, strict field/body limits, persistence across application restarts, exact owner/global admission and competing writers, idempotent replay at capacity, 24-hour expiry, disabled-service cleanup, stale temporary cleanup, beta capacity admission, safe corrupt-state failures and symbolic-state rejection on supported platforms. Tests use isolated temporary directories; source books, paid models, production data and external infrastructure are not used.

This PR is stacked on the English-typography implementation in backend PR #10. It does not merge that PR or enable/deploy feedback in production.
