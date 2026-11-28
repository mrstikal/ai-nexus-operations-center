# Documents: upload, admission, blob storage and download

This document describes the F15 document intake boundary and the F16 isolated digital parser.
It covers inert byte storage, digital page text, email attachments and job status. OCR and
vision are F26, structured extraction and human corrections are F17, and the document
workbench UI is F35.

## Contract

- `POST /api/v1/documents` (operator, CSRF + Origin checked) accepts one
  streamed multipart file in the `file` field, an optional `caseId` field or
  query parameter, and a UUID `Idempotency-Key` header.
- The declared media type must be one of `application/pdf`,
  `message/rfc822`, `text/plain`, `image/png` or `image/jpeg`.
- Maximum file size is 15 MiB (15,728,640 bytes) measured from actual received
  bytes. `Content-Length` is never trusted for admission.
- `GET /api/v1/documents` lists current document versions with bounded cursor
  pagination (default 25, maximum 100).
- `GET /api/v1/documents/:documentId` returns the current version metadata.
- `GET /api/v1/documents/:documentId/content` streams the stored bytes as an
  attachment with `X-Content-Type-Options: nosniff`, a private no-store cache
  header and a restrictive CSP. Only documents in the active sandbox resolve;
  another sandbox's ID is a 404.

Response shape for upload:

```json
{
  "document": {
    "id": "…",
    "documentId": "…",
    "sandboxId": "…",
    "caseId": null,
    "blobHash": "…",
    "mediaType": "text/plain",
    "originalFilename": "supplier-delay.txt",
    "sizeBytes": 734,
    "pageCount": null,
    "sourceEventId": null,
    "status": "uploaded",
    "parserVersion": null,
    "createdAt": "2026-11-27T18:00:00.000Z"
  },
  "jobId": "…",
  "duplicateOf": null
}
```

`duplicateOf` is the earliest document in the same sandbox whose bytes have the
same SHA-256. Identical bytes in a different sandbox are a separate blob and
are not reported as duplicates.

## Admission and validation

1. Bytes stream into `quarantine/<uuid>.part` under `NEXUS_BLOB_ROOT` while a
   SHA-256 is computed and the 15 MiB limit is enforced.
2. Media validation is performed from the stored bytes:
   - `%PDF-` signature for PDF;
   - PNG/JPEG signatures for images;
   - valid UTF-8 without NUL/control characters for text and email, with a
     header section required for `message/rfc822`.
   Content signature, declared media type and known filename extension must
   agree. A mismatch is rejected; nothing is marked extracted or ready.
3. A sanitized display filename is stored (path separators and control
   characters are removed) and the original file path is never used as a
   filesystem path.
4. Finalization moves the quarantine file to
   `blobs/<uuid prefix>/<uuid>` and only then commits the transaction that
   inserts the blob, document, version, pending extraction job, upload
   idempotency record and audit event. If the transaction fails, the just
   finalized file is removed. Duplicate bytes reuse the existing blob row and
   delete the newly finalized file.
5. Blob admission is a database-locked counter; the configured cap is
   `NEXUS_BLOB_ADMISSION_BYTES` (default 5 GiB, maximum 1 TiB). New unique
   bytes above the cap are rejected with `PAYLOAD_TOO_LARGE`. Duplicate bytes
   do not consume additional admission.
6. Document status starts at `uploaded` and an `extraction_jobs` row is
   created in `pending`. F15 never sets `ready`.

Idempotency is scoped to `(sandbox, actor, Idempotency-Key)`. Replaying the
same key with the same document identity returns the original document/job
identity; a changed body returns `IDEMPOTENCY_MISMATCH` (409).

## Storage layout

```
$NEXUS_BLOB_ROOT/
  quarantine/<uuid>.part   temporary, owned by an in-flight upload
  blobs/<first two hex>/<uuid>
```

Filenames on disk are random internal identifiers, never client paths or
display names. The default local root is `.data/blobs` (git-ignored). The
Compose infrastructure declares a private `nexus_blob_data` volume for the
application profile added in F66; the API and worker run with separate
credentials and no public object URL exists.

## Extraction (F16)

The API never parses document bytes. A worker claims a pending `extraction_jobs` row with a
database lease, streams the current version's bytes over the private parser network to the
`document-extractor` service, and validates the returned result before storing it.

- The extractor receives only the bytes, a job-correlation token and the validated media type.
  It has no database, blob-store, model or host mount, runs read-only
  with a capped tmpfs and no egress network, and enforces a per-request timeout in a bounded
  worker thread. The worker re-checks every page, attachment, hash and size; parser output is
  untrusted. The parser is not an antivirus or malware-scanning certification.
- Parser version: `f16-digital-v1`. Pinned `pdfjs-dist` 6.5.438 extracts digital PDF page
  text; pinned `mailparser` 3.15.0 reads plain text and attachments from `.eml`. HTML, remote
  images, PDF actions/JavaScript, scripts and external URLs are never rendered, executed or
  fetched.
- Limits: 20 pages, 40 megapixels per page, 200,000 characters per page, 10 email attachments,
  15 MiB per attachment and 120 seconds per job by default. `charCount` counts Unicode
  characters (code points), so text outside the Basic Multilingual Plane is valid. Encrypted,
  malformed, oversized or otherwise invalid documents become `rejected` with a typed reason;
  they are never `ready`.
- A PDF page (or an image document until F26) with fewer than 40 non-whitespace characters
  marks the document `needs_review` with `OCR_REQUIRED`, because it may be a scan rather than
  digital text. Text and email pages do not use that density rule: they are valid with at
  least one non-whitespace character, and only whitespace-only content becomes `needs_review`
  (`NO_TEXT`). Text pages are stored in `document_page_texts` as immutable
  `(documentVersionId, page, text, charCount)` rows with a valid page locator.
- Allowed email attachments (PDF, PNG, JPEG, EML, TXT) are stored as new child documents through
  the same blob/document/version/job tables and linked in `document_attachments`. A disallowed
  attachment marks the message `needs_review` (`UNSUPPORTED_ATTACHMENT`) without storing it.
- The parent status becomes `ready` only when actual valid content was extracted: at least one
  page must contain a non-whitespace character, and the worker re-checks this before completing
  the job. A whitespace-only text or email body becomes `needs_review` (`NO_TEXT`) without a
  ready event. In the same transaction the worker writes page text, attachments, the cache row
  and an audit event, and enqueues `nexus.document.ready.v1` in the transactional outbox.
  `needs_review` and `rejected` never emit `document.ready`.
- Every extraction job has at most three attempts. Transport, timeout, process-kill and storage
  failures return the job to `pending` with a bounded delay; a retry after lease expiry reuses
  the same job and cannot duplicate page rows or ready events. A cache row keyed by
  `(sandbox, blob SHA-256, parser version)` reuses an earlier extraction for duplicate bytes
  without calling the parser again.
- Configuration: `NEXUS_EXTRACTOR_URL` (worker target), `NEXUS_EXTRACTOR_TIMEOUT_MS` and
  `NEXUS_EXTRACTOR_MAX_BODY_BYTES` (extractor limits). The extractor is built by
  `infra/Dockerfile.extractor` and declared with `read_only`, `cap_drop: ALL`, `no-new-privileges`,
  a 512 MiB / 1 CPU bound and only the internal `parser` network.

## Structured extraction and correction (F17)

`DocumentExtractionService` classifies and extracts a ready document through the shared model
gateway. It uses the immutable stored page text, sends only that text (bounded to 16,000
characters) to the classify/extract roles, and validates the result against the closed
`document.extraction.v1` output schema (`packages/contracts/src/ai-outputs.ts`).

- Every field is `{ field, value|null, source|null, status, alternatives?, evidenceId }` with
  `status` in `extracted|corrected|missing|ambiguous`. `source` is an exact
  `{ documentVersionId, page, start, end }` span into `document_page_texts`; the value must match
  the spanned text. A missing page/span, an out-of-range offset or a value not present in the span
  becomes `ambiguous` with a null value, never a guessed value. A value on an `ambiguous` field
  without any source is also moved into `alternatives` and nulled. Any ambiguous financial or date
  field forces `needs_review` (`AMBIGUOUS_FINANCIAL_DATA`) even when the kind does not require it.
- Required fields (supplier/PO for supply, supplier/invoice/currency/net/tax/gross for invoices,
  supplier/delivery-note/PO for delivery notes, customer for customer requests) stay null when
  missing. Missing or ambiguous financial values are not converted to zero. Arithmetic
  (`net + tax = gross`), date validity and contradictory dates are checked deterministically after
  the model output; any failure marks the revision `reviewRequired` and the document
  `needs_review`.
- An extraction revision is immutable: revision 1 is `model`/`extracted`; a human correction
  creates a new `human`/`corrected` revision that supersedes it. Correction rows preserve the
  prior value, new value, actor, reason and timestamp. Optional human-provided spans are validated
  against the stored page text; a human value without a source is allowed only as an explicit
  correction.
- Each sourced field also inserts one immutable `evidence` row (`kind='document_page'`,
  locator page/start/end, content hash and captured facts) so proposals can cite the exact source.
- `PATCH /api/v1/documents/:documentId/extraction` requires operator role, CSRF, `If-Match` with
  the current revision number and a correction body. A stale revision is 409 `STALE_STATE`.
  Corrections invalidate open proposals citing the old extraction evidence (their evidence from
  the version) and expire the proposal/revision; if an execution derived from that evidence is
  `pending|in_progress|retryable_failure|unknown`, the correction is refused with 409 `CONFLICT`
  and the operator must reconcile first. The new revision, fields, correction rows, document
  status and proposal invalidation commit in one database transaction, so an invalidation failure
  rolls the correction back instead of leaving an approval bound to superseded evidence. Each
  correction row stores the field, prior value, new value, per-field reason, actor and timestamp;
  the request-level reason is stored on the immutable correction revision as `requestReason`.
  Before writing the new revision, the correction marks the prior extraction evidence rows with
  `superseded_at`/`superseded_reason` in the same transaction. Proposal creation and revision
  share-lock every cited evidence row and recheck availability inside their own transaction, so a
  proposal cannot commit against extraction evidence that a concurrent correction superseded;
  such a request is rejected as `ACTION_EVIDENCE_MISSING`.
- Extraction revisions, fields and corrections are append-only rows in
  `document_extraction_revisions`, `document_extraction_fields` and
  `document_extraction_corrections` (migration `0015_document_extraction_revisions.sql`).
  No `document.ready` event is emitted by F17; F20 composes extraction into the supply workflow.

## Failure behavior

- Unsupported media type: 415 `UNSUPPORTED_MEDIA`.
- Signature/extension/UTF-8 mismatch, empty file, bad cursor or limit:
  400 `VALIDATION_FAILED`.
- Over 15 MiB or over the admission cap: 413 `PAYLOAD_TOO_LARGE`.
- Reused idempotency key with a different body: 409 `IDEMPOTENCY_MISMATCH`.
- Missing/unauthorized document: 404 `NOT_FOUND` or 401/403 from the normal
  session and role guard.
- Blob filesystem failure: 503 `DEPENDENCY_UNAVAILABLE`.
- Extractor timeout, refusal, process kill or unavailable parser: the job is retried with a
  bounded delay (at most three attempts) and then becomes `failed` with an audit event. A typed
  parser rejection becomes document status `rejected`; a low-text scan becomes `needs_review`
  with `OCR_REQUIRED`. None of them emits `document.ready`.

Failed finalization removes only the upload's own temporary or just-created
blob file. No retention or bulk deletion is implemented in F15; F57 owns
reference-safe cleanup.

## Out of scope

No OCR, rasterization, vision fallback, image field extraction, preview rendering, content
searching or document workbench UI are implemented
in F15/F16. Image and scanned documents become `needs_review` until F26. The API never executes
a document, and parsing never runs in the API or browser process.
