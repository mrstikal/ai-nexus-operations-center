CREATE TABLE nexus.knowledge_documents (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes (id),
  kind text NOT NULL,
  policy_id text,
  source_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT knowledge_documents_kind_check CHECK (
    kind IN ('policy', 'informational')
  ),
  CONSTRAINT knowledge_documents_policy_check CHECK (
    (kind = 'policy' AND policy_id IS NOT NULL)
    OR (kind = 'informational' AND policy_id IS NULL)
  ),
  CONSTRAINT knowledge_documents_path_check CHECK (
    source_path ~ '^fixtures/(knowledge/[a-z0-9][a-z0-9._-]{0,99}|security/inject-policy)\.md$'
  ),
  CONSTRAINT knowledge_documents_sandbox_id_id_key UNIQUE (sandbox_id, id)
);

CREATE INDEX knowledge_documents_sandbox_created_idx
  ON nexus.knowledge_documents (sandbox_id, created_at, id);

CREATE TABLE nexus.knowledge_versions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_no integer NOT NULL,
  state text NOT NULL,
  content_sha256 text NOT NULL,
  policy_bundle_version text,
  policy_content_hash text,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  published_at timestamptz,
  withdrawn_at timestamptz,
  source_path text NOT NULL,
  char_count integer NOT NULL,
  chunk_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT knowledge_versions_state_check CHECK (
    state IN ('draft', 'published', 'superseded', 'withdrawn')
  ),
  CONSTRAINT knowledge_versions_version_check CHECK (
    version_no BETWEEN 1 AND 1000000
  ),
  CONSTRAINT knowledge_versions_content_hash_check CHECK (
    content_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT knowledge_versions_policy_hash_check CHECK (
    policy_content_hash IS NULL
    OR policy_content_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT knowledge_versions_policy_link_check CHECK (
    (policy_bundle_version IS NULL AND policy_content_hash IS NULL)
    OR (
      policy_bundle_version IS NOT NULL
      AND length(policy_bundle_version) BETWEEN 1 AND 100
      AND policy_content_hash IS NOT NULL
    )
  ),
  CONSTRAINT knowledge_versions_count_check CHECK (
    char_count >= 0 AND chunk_count BETWEEN 1 AND 10000
  ),
  CONSTRAINT knowledge_versions_path_check CHECK (
    source_path ~ '^fixtures/(knowledge/[a-z0-9][a-z0-9._-]{0,99}|security/inject-policy)\.md$'
  ),
  CONSTRAINT knowledge_versions_withdrawn_check CHECK (
    withdrawn_at IS NULL OR state IN ('withdrawn', 'superseded')
  ),
  CONSTRAINT knowledge_versions_document_version_key UNIQUE (
    sandbox_id, document_id, version_no
  ),
  CONSTRAINT knowledge_versions_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT knowledge_versions_document_fk FOREIGN KEY (sandbox_id, document_id)
    REFERENCES nexus.knowledge_documents (sandbox_id, id)
);

CREATE INDEX knowledge_versions_publication_idx
  ON nexus.knowledge_versions (sandbox_id, state, effective_from);

CREATE TABLE nexus.knowledge_chunks (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  heading_path jsonb NOT NULL,
  text text NOT NULL,
  char_count integer NOT NULL,
  token_count integer NOT NULL,
  locator jsonb NOT NULL,
  content_sha256 text NOT NULL,
  evidence_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT knowledge_chunks_index_check CHECK (
    chunk_index BETWEEN 0 AND 9999
  ),
  CONSTRAINT knowledge_chunks_text_check CHECK (
    char_length(text) BETWEEN 1 AND 20000 AND char_count = char_length(text)
  ),
  CONSTRAINT knowledge_chunks_token_check CHECK (
    token_count BETWEEN 1 AND 1200
  ),
  CONSTRAINT knowledge_chunks_hash_check CHECK (
    content_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT knowledge_chunks_version_index_key UNIQUE (
    sandbox_id, document_version_id, chunk_index
  ),
  CONSTRAINT knowledge_chunks_version_fk FOREIGN KEY (
    sandbox_id, document_version_id
  ) REFERENCES nexus.knowledge_versions (sandbox_id, id),
  CONSTRAINT knowledge_chunks_evidence_fk FOREIGN KEY (
    sandbox_id, evidence_id
  ) REFERENCES nexus.evidence (sandbox_id, id)
);

CREATE INDEX knowledge_chunks_version_idx
  ON nexus.knowledge_chunks (sandbox_id, document_version_id);

CREATE INDEX knowledge_chunks_evidence_idx
  ON nexus.knowledge_chunks (sandbox_id, evidence_id);

CREATE INDEX knowledge_chunks_fts_idx
  ON nexus.knowledge_chunks USING gin (to_tsvector('english', text));

CREATE TABLE nexus.knowledge_retrieval_state (
  sandbox_id uuid PRIMARY KEY REFERENCES nexus.sandboxes (id),
  generation integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT knowledge_retrieval_state_generation_check CHECK (
    generation BETWEEN 1 AND 2147483647
  )
);

ALTER TABLE nexus.evidence DROP CONSTRAINT evidence_kind_check;
ALTER TABLE nexus.evidence ADD CONSTRAINT evidence_kind_check CHECK (
  kind IN (
    'enterprise_snapshot', 'document_page', 'policy_version',
    'knowledge_chunk', 'calculation', 'historical_memory',
    'reconciliation_report'
  )
);

REVOKE ALL ON
  nexus.knowledge_documents,
  nexus.knowledge_versions,
  nexus.knowledge_chunks,
  nexus.knowledge_retrieval_state
FROM PUBLIC;

GRANT SELECT, INSERT ON
  nexus.knowledge_documents,
  nexus.knowledge_versions,
  nexus.knowledge_chunks
TO nexus_api;

GRANT UPDATE (id) ON nexus.knowledge_documents TO nexus_api;

GRANT UPDATE (state, effective_until, published_at, withdrawn_at, updated_at)
  ON nexus.knowledge_versions TO nexus_api;

GRANT UPDATE (evidence_id) ON nexus.knowledge_chunks TO nexus_api;

GRANT SELECT, INSERT ON nexus.knowledge_retrieval_state TO nexus_api;
GRANT UPDATE (generation, updated_at)
  ON nexus.knowledge_retrieval_state TO nexus_api;

GRANT UPDATE (status, wait_reason, version, updated_at)
  ON nexus.workflow_runs TO nexus_api;
