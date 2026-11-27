CREATE TABLE nexus.blobs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes (id),
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  media_type text NOT NULL,
  storage_key text NOT NULL,
  state text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT blobs_sha_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT blobs_size_check CHECK (size_bytes > 0 AND size_bytes <= 15728640),
  CONSTRAINT blobs_media_type_check CHECK (
    media_type IN ('application/pdf', 'message/rfc822', 'text/plain', 'image/png', 'image/jpeg')
  ),
  CONSTRAINT blobs_state_check CHECK (state IN ('available', 'deleted')),
  CONSTRAINT blobs_storage_key_check CHECK (
    storage_key ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  ),
  CONSTRAINT blobs_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT blobs_storage_key_key UNIQUE (storage_key)
);

CREATE UNIQUE INDEX blobs_sandbox_sha_active_key
  ON nexus.blobs (sandbox_id, sha256)
  WHERE state = 'available';

CREATE TABLE nexus.blob_storage_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  used_bytes bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT blob_storage_state_singleton_check CHECK (singleton),
  CONSTRAINT blob_storage_state_used_check CHECK (used_bytes >= 0)
);

INSERT INTO nexus.blob_storage_state (singleton, used_bytes)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE nexus.documents (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes (id),
  case_id uuid,
  status text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT documents_status_check CHECK (
    status IN ('uploaded', 'validating', 'extracting', 'needs_review', 'ready', 'rejected', 'failed')
  ),
  CONSTRAINT documents_version_check CHECK (version >= 1),
  CONSTRAINT documents_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT documents_case_fk FOREIGN KEY (sandbox_id, case_id)
    REFERENCES nexus.cases (sandbox_id, id)
);

CREATE INDEX documents_sandbox_status_idx
  ON nexus.documents (sandbox_id, status, created_at);

CREATE TABLE nexus.document_versions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_no integer NOT NULL,
  blob_id uuid NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL,
  page_count integer,
  parser_version text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_versions_status_check CHECK (
    status IN ('uploaded', 'validating', 'extracting', 'needs_review', 'ready', 'rejected', 'failed')
  ),
  CONSTRAINT document_versions_media_type_check CHECK (
    media_type IN ('application/pdf', 'message/rfc822', 'text/plain', 'image/png', 'image/jpeg')
  ),
  CONSTRAINT document_versions_size_check CHECK (
    size_bytes > 0 AND size_bytes <= 15728640
  ),
  CONSTRAINT document_versions_sha_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT document_versions_filename_check CHECK (
    length(filename) BETWEEN 1 AND 200
  ),
  CONSTRAINT document_versions_page_count_check CHECK (
    page_count IS NULL OR page_count BETWEEN 1 AND 1000
  ),
  CONSTRAINT document_versions_parser_version_check CHECK (
    parser_version IS NULL OR length(parser_version) BETWEEN 1 AND 100
  ),
  CONSTRAINT document_versions_version_check CHECK (version_no >= 1),
  CONSTRAINT document_versions_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT document_versions_document_version_key
    UNIQUE (sandbox_id, document_id, version_no),
  CONSTRAINT document_versions_document_fk FOREIGN KEY (sandbox_id, document_id)
    REFERENCES nexus.documents (sandbox_id, id),
  CONSTRAINT document_versions_blob_fk FOREIGN KEY (sandbox_id, blob_id)
    REFERENCES nexus.blobs (sandbox_id, id)
);

CREATE INDEX document_versions_blob_idx
  ON nexus.document_versions (sandbox_id, blob_id);

CREATE TABLE nexus.extraction_jobs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT extraction_jobs_state_check CHECK (
    state IN ('pending', 'leased', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT extraction_jobs_attempt_check CHECK (
    attempt_count >= 0 AND max_attempts BETWEEN 1 AND 3 AND attempt_count <= 3
  ),
  CONSTRAINT extraction_jobs_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT extraction_jobs_version_fk FOREIGN KEY (sandbox_id, document_version_id)
    REFERENCES nexus.document_versions (sandbox_id, id)
);

CREATE INDEX extraction_jobs_claim_idx
  ON nexus.extraction_jobs (state, available_at, created_at);

CREATE UNIQUE INDEX extraction_jobs_active_version_key
  ON nexus.extraction_jobs (sandbox_id, document_version_id)
  WHERE state IN ('pending', 'leased');

CREATE TABLE nexus.document_uploads (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  actor_id text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  document_version_id uuid NOT NULL,
  duplicate_of uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_uploads_request_hash_check CHECK (
    request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT document_uploads_idempotency_key UNIQUE (
    sandbox_id, actor_id, idempotency_key
  ),
  CONSTRAINT document_uploads_version_key UNIQUE (document_version_id),
  CONSTRAINT document_uploads_version_fk FOREIGN KEY (sandbox_id, document_version_id)
    REFERENCES nexus.document_versions (sandbox_id, id)
);

REVOKE ALL ON
  nexus.blobs,
  nexus.blob_storage_state,
  nexus.documents,
  nexus.document_versions,
  nexus.extraction_jobs,
  nexus.document_uploads
FROM PUBLIC;

GRANT SELECT, INSERT ON nexus.blobs TO nexus_api;
GRANT SELECT, INSERT ON nexus.documents TO nexus_api;
GRANT UPDATE (status, version, updated_at, case_id) ON nexus.documents TO nexus_api;
GRANT SELECT, INSERT ON nexus.document_versions TO nexus_api;
GRANT SELECT, INSERT ON nexus.extraction_jobs TO nexus_api;
GRANT SELECT, INSERT ON nexus.document_uploads TO nexus_api;
GRANT SELECT ON nexus.blob_storage_state TO nexus_api;
GRANT UPDATE (used_bytes, updated_at) ON nexus.blob_storage_state TO nexus_api;

GRANT SELECT ON
  nexus.blobs,
  nexus.blob_storage_state,
  nexus.documents,
  nexus.document_versions,
  nexus.extraction_jobs
TO nexus_worker;
