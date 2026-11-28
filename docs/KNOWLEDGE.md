# NEXUS Knowledge and Retrieval

Status: F18 implements versioned knowledge, deterministic lexical retrieval and publication
invalidation. Embeddings, hybrid ranking, a reranker and the knowledge UI remain later stages
(F27, F48). See [ADR 007](adr/007-lexical-hybrid-retrieval.md).

## Authority and sources

`config/policies/northstar-v1.json` remains the single executable policy bundle and
`fixtures/knowledge/northstar-v1.md` remains its canonical human-readable source. Knowledge
ingestion never creates or edits a second policy source. A policy knowledge version is
publishable only when its exact source path and SHA-256 match the loaded bundle's canonical
text; any mismatch keeps the version in `draft` and returns a conflict. Informational documents
(for example `fixtures/knowledge/support-guide.md`) may explain behavior but can never supply
executable rules, roles, thresholds or approvals.

`fixtures/security/inject-policy.md` is ingested and indexed as untrusted text in the tests. It
is blocked from policy publication by the hash check and remains inert data when published as an
informational document.

## Retrieval port

`packages/application/src/ports/knowledge.ts` defines the stable `KnowledgeRetriever.search`
port. The result is:

```
{
  mode: 'lexical',
  queryId: '<uuid>',
  noEvidence: boolean,
  chunks: [{
    id, documentVersionId, policyBundleVersion|null,
    text, locator: { sourcePath, headingPath, startOffset, endOffset },
    score, evidenceId
  }]
}
```

F18 implements `LexicalKnowledgeRetriever` over PostgreSQL full-text search. F27 may add a
hybrid implementation behind the same interface without changing its callers. An empty result
is an explicit `noEvidence` outcome; the service never fabricates a citation. Live balances,
order state, permissions and contract values must still come from exact enterprise read tools,
not from retrieval.

## Versions, chunks and locators

`nexus.knowledge_documents` identifies a source by sandbox, kind (`policy` or `informational`),
optional policy ID and registered source path. `nexus.knowledge_versions` stores immutable
content hashes, optional policy bundle identity, effective dates and the lifecycle state
`draft`, `published`, `superseded` or `withdrawn`. `nexus.knowledge_chunks` stores each chunk's
exact text, heading path, code-point source offsets and content hash.

Chunking is deterministic: markdown is split at headings, chunks do not cross a section, the
target is 600 whitespace tokens, consecutive chunks in a section overlap by 80 tokens and no
chunk exceeds 1,200 tokens. Offsets are Unicode code points into the exact decoded source text;
`sliceKnowledgeText` reproduces the chunk text from its locator. Searching uses parameterized
queries with the explicit `english` text-search configuration and an expression GIN index.

Metadata filters are applied inside SQL before ranking: sandbox, publication state, document
kind, policy ID and the effective-time window (`effective_from <= effectiveAt <
effective_until`). Superseded, withdrawn, expired, draft and cross-sandbox chunks never appear
in new results. Published versions are retained with their chunks and evidence so historical
traces keep resolving the exact pinned version after a newer publication.

## Publication, revocation and invalidation

Only admins ingest, publish or revoke; operators may search; viewers may list documents.
Repeated ingestion of identical bytes is idempotent and returns the existing draft or published
version. Publication marks prior published versions of the same document `superseded`, sets
`effective_until`, attaches one `knowledge_chunk` evidence row per chunk and rejects an empty or
unmatched policy source.

Every publication or revocation increments the sandbox's committed retrieval generation in
`nexus.knowledge_retrieval_state` and writes a `nexus.knowledge.changed.v1` outbox record with
the document/version IDs, `published`/`withdrawn` state and generation. For policy documents the
same transaction expires every open unexecuted proposal (`draft`, `pending_approval`,
`approved`) and supersedes its approval decisions, because the executable policy evidence is no
longer current. Informational changes do not invalidate proposals. Asynchronous cache
invalidation is an optimization only; permission and policy correctness come from the committed
state.

## API

| Route | Role | Behavior |
|---|---|---|
| `GET /api/v1/knowledge` | viewer | Cursor-paginated catalog of knowledge documents and their latest version |
| `POST /api/v1/knowledge` | admin | Ingest a registered fixture path into a draft version |
| `POST /api/v1/knowledge/{documentId}/publish` | admin | Publish the latest draft after policy hash validation |
| `POST /api/v1/knowledge/{documentId}/revoke` | admin | Withdraw a published version with a reason |
| `POST /api/v1/knowledge/search` | operator | Lexical evidence search in the active sandbox |

Mutations require session, same-origin CSRF and role checks. Search and list return
`no-store` responses. Missing documents return `NOT_FOUND`; a policy mismatch, missing draft or
missing published version returns `CONFLICT`; malformed bodies, paths or bounds return
`VALIDATION_FAILED`.

## Non-goals in F18

- No embeddings, vector columns or hybrid ranking (F27).
- No reranker, external search service or network dependency.
- No knowledge management UI (F48).
- No second executable policy source or model-generated policy.
