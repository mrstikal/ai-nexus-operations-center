# Documents: upload, admission, blob storage and download

This document describes the F15 document intake boundary. It covers inert byte
storage only. PDF/email parsing is F16, structured extraction and human
corrections are F17, OCR is F26, and the document workbench UI is F35.

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
    "sandboxId": "…",
    "caseId": null,
    "filename": "supplier-delay.txt",
    "mediaType": "text/plain",
    "sizeBytes": 734,
    "sha256": "…",
    "status": "uploaded",
    "pageCount": null,
    "parserVersion": null,
    "version": 1,
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
3. A namespaced display filename is stored (path separators and control
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

## Failure behavior

- Unsupported media type: 415 `UNSUPPORTED_MEDIA`.
- Signature/extension/UTF-8 mismatch, empty file, bad cursor or limit:
  400 `VALIDATION_FAILED`.
- Over 15 MiB or over the admission cap: 413 `PAYLOAD_TOO_LARGE`.
- Reused idempotency key with a different body: 409 `IDEMPOTENCY_MISMATCH`.
- Missing/unauthorized document: 404 `NOT_FOUND` or 401/403 from the normal
  session and role guard.
- Blob filesystem failure: 503 `DEPENDENCY_UNAVAILABLE`.

Failed finalization removes only the upload's own temporary or just-created
blob file. No retention or bulk deletion is implemented in F15; F57 owns
reference-safe cleanup.

## Out of scope

No PDF/email parsing, OCR, text extraction, preview rendering, content
searching or automatic document status transitions happen in this stage. The
API never executes a document.
