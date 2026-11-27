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

No OCR, rasterization, vision fallback, image field extraction, structured business fields,
human corrections, preview rendering, content searching or document workbench UI are implemented
in F15/F16. Image and scanned documents become `needs_review` until F26. The API never executes
a document, and parsing never runs in the API or browser process.
