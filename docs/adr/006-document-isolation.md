# ADR 006: Document isolation, inert intake and private blobs

Status: accepted for F15 (intake boundary) and F16 (isolated digital parser). OCR/vision and
structured extraction remain later stages.

## Context

NEXUS accepts supplier and customer documents that are untrusted input. The
product needs locatable text and structured fields later, but arbitrary PDF,
email or image parsing inside the HTTP API or browser would make the request
path a hostile-parser attack surface. The fixed architecture (plan section
2.4) requires a privilege-separated extractor, private blobs and no public
object URLs.

This ADR records the intake and parser decisions; it does not add a second document
architecture. F16 extends this file with the isolated parser as built.

## Decision

1. The API streams uploads into a private quarantine directory, enforces the
   15 MiB limit from actual bytes, validates basic signatures/UTF-8 and moves
   accepted bytes into a random-keyed private blob directory.
2. The API stores metadata only: blob hash/size/media type, document and
   immutable document version, a pending extraction job and an audit event.
   Accepted documents remain `uploaded`; magic bytes never imply extraction or
   readiness.
3. Blob keys are random internal identifiers. Display filenames are escaped
   metadata and are never used as filesystem paths.
4. Downloads require an authenticated session, are sandbox-scoped, are served
   as attachments with `nosniff`, a restrictive CSP and no public URL.
5. No PDF/email parsing, OCR, rendering or executable content occurs in the
   API or browser. F16 runs digital parsing in the isolated extractor service
   described in the plan, connected only to its parser network, with no
   database, blob-store, model or host credentials.
6. A database-locked admission counter bounds private blob storage. Only the
   narrow API role can insert document metadata; the worker receives read
   access for later processing.
7. Quarantine and just-finalized files are cleaned up only when the owning
   upload fails. No global volume deletion or retention purge is part of
   intake.

## Consequences

- A hostile document cannot run inside the request path and is never served
  with an executable content type or an inline disposition.
- Finalizing a file and committing metadata are not one distributed
  transaction. A crash between the file move and the database commit can leave
  an unreferenced blob file; it is never treated as a document, and reference-
  safe cleanup is deferred to F57.
- Duplicate bytes inside a sandbox share one blob row; duplicates are reported
  through `duplicateOf`. Another sandbox never shares the row or file.
- Page text is delivered by F16; structured extraction and human corrections
  require the F17 stages and cannot be claimed from this ADR.

## Alternatives considered

- Parse PDFs in the API process: rejected because parser exploits would reach
  application credentials and the database.
- Store blobs in a public static directory or object URL: rejected because
  documents need authorization and content-disposition control.
- Mark documents ready after magic-byte validation: rejected because it would
  claim extraction that never ran.
- Reuse client filenames as storage keys: rejected because of traversal,
  collision and disclosure risks.

## As-built (F15)

- `packages/application/src/documents/admission.ts` implements media/size
  validation, filename escaping and admission configuration.
- `packages/application/src/documents/blob-store.ts` implements the private
  filesystem quarantine/finalize/read boundary.
- `packages/application/src/documents/upload.ts` implements upload
  idempotency, duplicate detection and download metadata.
- `packages/db/src/schema/documents.ts` and migration `0013_documents.sql`
  define blobs, blob admission state, documents, immutable versions,
  extraction jobs and upload idempotency records.
- `apps/api/src/documents/controller.ts` exposes authenticated upload,
  list/detail and attachment download routes; the API never parses document
  content.

## As-built (F16)

- `apps/document-extractor` is a standalone HTTP service. It receives raw
  bytes plus a job-correlation token and media type, and
  parses digital PDFs (`pdfjs-dist` 6.5.438), plain email text and bounded
  attachments (`mailparser` 3.15.0) and UTF-8 text. It has no database, blob,
  model or host mounts, no egress network, a read-only root and a capped
  tmpfs, and it runs each parse in a worker thread with a hard timeout and a
  256 MiB old-generation bound.
- `infra/Dockerfile.extractor` and the `extractor` Compose profile run it with
  `read_only`, `cap_drop: ALL`, `no-new-privileges`, a 512 MiB / 1 CPU limit,
  no published ports and only the internal `parser` network.
- `packages/application/src/documents/processing.ts` and
  `packages/db/src/repositories/document-processing.ts` claim jobs with
  leases, stream current-version bytes, validate the parser result, store
  immutable page text and attachment child documents, cache by
  `(sandbox, blob hash, parser version)`, retry transport failures at most
  three times and finalize status, audit and `nexus.document.ready.v1`
  transactionally.
- Encrypted, malformed and oversized documents become `rejected`. PDF pages
  (and image documents until F26) with fewer than 40 non-whitespace characters
  become `needs_review` with `OCR_REQUIRED`; text and email pages require only
  at least one non-whitespace character, and whitespace-only content becomes
  `needs_review` with `NO_TEXT`. Nothing is marked `ready` without actual
  extracted content.
- `apps/worker/src/document.module.ts` runs the document loop when
  `NEXUS_EXTRACTOR_URL` is configured. The API process has no parser
  dependency.

## Related

- [Documents contract](../DOCUMENTS.md)
- [Security guide](../SECURITY.md)
- [Data model](../DATA_MODEL.md)
- [Sandbox isolation ADR 011](011-sandbox-isolation.md)
- Historical event/outbox ADR remains at `006-durable-events.md`; this file is
  the plan-numbered document-isolation ADR and does not supersede it.
