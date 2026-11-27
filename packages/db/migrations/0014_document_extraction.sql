CREATE TABLE nexus.document_page_texts (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  page_no integer NOT NULL,
  text text NOT NULL,
  char_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_page_texts_page_check CHECK (page_no BETWEEN 1 AND 20),
  CONSTRAINT document_page_texts_text_check CHECK (
    char_length(text) <= 200000 AND char_count = char_length(text)
  ),
  CONSTRAINT document_page_texts_version_page_key UNIQUE (
    sandbox_id, document_version_id, page_no
  ),
  CONSTRAINT document_page_texts_version_fk FOREIGN KEY (
    sandbox_id, document_version_id
  ) REFERENCES nexus.document_versions (sandbox_id, id)
);

CREATE INDEX document_page_texts_version_idx
  ON nexus.document_page_texts (sandbox_id, document_version_id);

CREATE TABLE nexus.document_attachments (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  parent_document_version_id uuid NOT NULL,
  attachment_document_version_id uuid NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_attachments_media_type_check CHECK (
    media_type IN ('application/pdf', 'message/rfc822', 'text/plain', 'image/png', 'image/jpeg')
  ),
  CONSTRAINT document_attachments_size_check CHECK (
    size_bytes > 0 AND size_bytes <= 15728640
  ),
  CONSTRAINT document_attachments_sha_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT document_attachments_filename_check CHECK (
    length(filename) BETWEEN 1 AND 200
  ),
  CONSTRAINT document_attachments_parent_sha_key UNIQUE (
    sandbox_id, parent_document_version_id, sha256
  ),
  CONSTRAINT document_attachments_parent_version_key UNIQUE (
    sandbox_id, parent_document_version_id, attachment_document_version_id
  ),
  CONSTRAINT document_attachments_parent_fk FOREIGN KEY (
    sandbox_id, parent_document_version_id
  ) REFERENCES nexus.document_versions (sandbox_id, id),
  CONSTRAINT document_attachments_child_fk FOREIGN KEY (
    sandbox_id, attachment_document_version_id
  ) REFERENCES nexus.document_versions (sandbox_id, id)
);

CREATE TABLE nexus.document_extraction_cache (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  blob_sha256 text NOT NULL,
  parser_version text NOT NULL,
  source_document_version_id uuid NOT NULL,
  format text NOT NULL,
  status text NOT NULL,
  reason_code text,
  page_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_extraction_cache_sha_check CHECK (
    blob_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT document_extraction_cache_format_check CHECK (
    format IN ('digital_pdf', 'email', 'text', 'image')
  ),
  CONSTRAINT document_extraction_cache_status_check CHECK (
    status IN ('ready', 'needs_review', 'rejected')
  ),
  CONSTRAINT document_extraction_cache_page_count_check CHECK (
    page_count BETWEEN 1 AND 20
  ),
  CONSTRAINT document_extraction_cache_parser_version_check CHECK (
    length(parser_version) BETWEEN 1 AND 100
  ),
  CONSTRAINT document_extraction_cache_key UNIQUE (
    sandbox_id, blob_sha256, parser_version
  ),
  CONSTRAINT document_extraction_cache_source_fk FOREIGN KEY (
    sandbox_id, source_document_version_id
  ) REFERENCES nexus.document_versions (sandbox_id, id)
);

REVOKE ALL ON
  nexus.document_page_texts,
  nexus.document_attachments,
  nexus.document_extraction_cache
FROM PUBLIC;

GRANT SELECT, INSERT ON
  nexus.document_page_texts,
  nexus.document_attachments,
  nexus.document_extraction_cache
TO nexus_worker;

GRANT SELECT, INSERT ON nexus.documents TO nexus_worker;
GRANT UPDATE (status, version, updated_at, case_id) ON nexus.documents TO nexus_worker;
GRANT SELECT, INSERT ON nexus.document_versions TO nexus_worker;
GRANT UPDATE (status, page_count, parser_version) ON nexus.document_versions TO nexus_worker;
GRANT SELECT, INSERT ON nexus.extraction_jobs TO nexus_worker;
GRANT UPDATE (
  state,
  attempt_count,
  available_at,
  lease_owner,
  lease_expires_at,
  last_error,
  version,
  updated_at
) ON nexus.extraction_jobs TO nexus_worker;
GRANT SELECT, INSERT ON nexus.blobs TO nexus_worker;
GRANT SELECT ON nexus.blob_storage_state TO nexus_worker;
GRANT UPDATE (used_bytes, updated_at) ON nexus.blob_storage_state TO nexus_worker;
