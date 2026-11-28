# ADR 007: Lexical-first retrieval behind a stable port

Status: accepted (F18), superseded in part by F27 for hybrid ranking.

## Context

The supply workflow needs real, citable policy evidence before the first end-to-end scenario.
Embeddings, a vector index and reciprocal rank fusion are specified for F27, but the workflow
and verification layers must not depend on a ranking implementation that does not exist yet. A
later embedding model change must not rewrite callers or invalidate stored policy evidence.

## Decision

1. Define a stable `KnowledgeRetriever.search` port in the application layer. Callers receive a
   mode, query ID, at most six chunks with exact source locators and evidence IDs, and an
   explicit no-evidence outcome.
2. Implement F18 with deterministic PostgreSQL full-text search using the explicit `english`
   configuration, metadata filters applied in SQL before ranking and a stable tie-break by chunk
   ID. There is no network or paid dependency.
3. Store immutable versions and chunks with code-point locators and attach one evidence row per
   published chunk. Publication and revocation bump a committed retrieval generation and emit
   `nexus.knowledge.changed.v1`; policy changes expire unexecuted proposals in the same
   transaction.
4. Keep embeddings, vector columns/indexes and reciprocal rank fusion out of F18. F27 adds them
   as a second implementation behind the same port, with an atomically switched generation when
   the embedding model or dimension changes.

## Alternatives considered

- **Embeddings and hybrid search now:** rejected for F18 because it would make the first
  vertical depend on an unbuilt indexing pipeline and an external model, while adding no new
  citation guarantee. F27 owns it.
- **External search service:** rejected; it adds infrastructure and a network dependency without
  solving authorization, version pinning or deterministic tests.
- **Serving policy text from the config bundle directly:** rejected; the workflow needs locatable
  chunk evidence and a publication lifecycle, not just a file read.

## Consequences

- Retrieval quality is lexical until F27; exact terms and English stemming work, synonyms do not.
- Metadata filtering, version pinning, no-evidence behavior and invalidation semantics are fixed
  before hybrid ranking arrives.
- F27 must keep the port, exclude superseded/withdrawn/expired versions and preserve the
  generation switch; changing embedding dimensions requires a new generation rather than mixing
  vectors.
- Asynchronous cache invalidation may use the event and generation, but correctness must always
  recheck committed visibility.
