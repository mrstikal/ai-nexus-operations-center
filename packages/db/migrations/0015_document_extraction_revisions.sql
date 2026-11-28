CREATE TABLE nexus.document_extraction_revisions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes (id),
  document_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  revision_number integer NOT NULL,
  kind text NOT NULL,
  revision_status text NOT NULL,
  authored_by_kind text NOT NULL,
  authored_by_id text NOT NULL,
  supersedes_revision_id uuid,
  review_required boolean NOT NULL,
  review_reason text,
  request_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_extraction_revisions_number_check CHECK (
    revision_number BETWEEN 1 AND 1000000
  ),
  CONSTRAINT document_extraction_revisions_kind_check CHECK (
    kind IN (
      'supply_exception', 'invoice', 'delivery_note', 'customer_request',
      'knowledge_document', 'other', 'unknown'
    )
  ),
  CONSTRAINT document_extraction_revisions_status_check CHECK (
    revision_status IN ('extracted', 'corrected')
  ),
  CONSTRAINT document_extraction_revisions_author_check CHECK (
    authored_by_kind IN ('model', 'human')
    AND length(authored_by_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT document_extraction_revisions_review_check CHECK (
    (review_required AND review_reason IS NOT NULL)
    OR (NOT review_required AND review_reason IS NULL)
  ),
  CONSTRAINT document_extraction_revisions_request_reason_check CHECK (
    (
      authored_by_kind = 'human'
      AND request_reason IS NOT NULL
      AND length(request_reason) BETWEEN 1 AND 1000
    )
    OR (authored_by_kind = 'model' AND request_reason IS NULL)
  ),
  CONSTRAINT document_extraction_revisions_version_number_key UNIQUE (
    sandbox_id, document_version_id, revision_number
  ),
  CONSTRAINT document_extraction_revisions_sandbox_id_id_key UNIQUE (
    sandbox_id, id
  ),
  CONSTRAINT document_extraction_revisions_document_fk FOREIGN KEY (
    sandbox_id, document_id
  ) REFERENCES nexus.documents (sandbox_id, id),
  CONSTRAINT document_extraction_revisions_version_fk FOREIGN KEY (
    sandbox_id, document_version_id
  ) REFERENCES nexus.document_versions (sandbox_id, id)
);

CREATE INDEX document_extraction_revisions_document_idx
  ON nexus.document_extraction_revisions (sandbox_id, document_id, created_at);

CREATE TABLE nexus.document_extraction_fields (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  field text NOT NULL,
  value text,
  status text NOT NULL,
  source_page integer,
  source_start integer,
  source_end integer,
  source_bbox jsonb,
  alternatives jsonb,
  evidence_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_extraction_fields_field_check CHECK (
    field IN (
      'supplier_name', 'customer_name', 'purchase_order_number',
      'invoice_number', 'delivery_note_number', 'sales_order_number',
      'document_date', 'delivery_date', 'due_date', 'currency',
      'net_amount_minor', 'tax_amount_minor', 'gross_amount_minor',
      'tax_rate_bps', 'total_quantity', 'unit_price_minor', 'description'
    )
  ),
  CONSTRAINT document_extraction_fields_status_check CHECK (
    status IN ('extracted', 'corrected', 'missing', 'ambiguous')
  ),
  CONSTRAINT document_extraction_fields_value_check CHECK (
    (
      status IN ('extracted', 'corrected')
      AND value IS NOT NULL AND length(value) BETWEEN 1 AND 5000
    )
    OR (status = 'missing' AND value IS NULL)
    OR (
      status = 'ambiguous'
      AND (value IS NULL OR length(value) BETWEEN 1 AND 5000)
    )
  ),
  CONSTRAINT document_extraction_fields_source_check CHECK (
    (
      source_page IS NULL AND source_start IS NULL AND source_end IS NULL
    )
    OR (
      source_page BETWEEN 1 AND 20
      AND source_start >= 0
      AND source_end > source_start
    )
  ),
  CONSTRAINT document_extraction_fields_evidence_source_check CHECK (
    evidence_id IS NULL OR source_page IS NOT NULL
  ),
  CONSTRAINT document_extraction_fields_revision_field_key UNIQUE (
    sandbox_id, revision_id, field
  ),
  CONSTRAINT document_extraction_fields_revision_fk FOREIGN KEY (
    sandbox_id, revision_id
  ) REFERENCES nexus.document_extraction_revisions (sandbox_id, id),
  CONSTRAINT document_extraction_fields_evidence_fk FOREIGN KEY (
    sandbox_id, evidence_id
  ) REFERENCES nexus.evidence (sandbox_id, id)
);

CREATE INDEX document_extraction_fields_revision_idx
  ON nexus.document_extraction_fields (sandbox_id, revision_id);

CREATE INDEX document_extraction_fields_evidence_idx
  ON nexus.document_extraction_fields (sandbox_id, evidence_id);

CREATE TABLE nexus.document_extraction_corrections (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  field text NOT NULL,
  prior_value text,
  new_value text,
  reason text NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_extraction_corrections_field_check CHECK (
    field IN (
      'supplier_name', 'customer_name', 'purchase_order_number',
      'invoice_number', 'delivery_note_number', 'sales_order_number',
      'document_date', 'delivery_date', 'due_date', 'currency',
      'net_amount_minor', 'tax_amount_minor', 'gross_amount_minor',
      'tax_rate_bps', 'total_quantity', 'unit_price_minor', 'description'
    )
  ),
  CONSTRAINT document_extraction_corrections_reason_check CHECK (
    length(reason) BETWEEN 1 AND 1000
  ),
  CONSTRAINT document_extraction_corrections_revision_field_key UNIQUE (
    sandbox_id, revision_id, field
  ),
  CONSTRAINT document_extraction_corrections_revision_fk FOREIGN KEY (
    sandbox_id, revision_id
  ) REFERENCES nexus.document_extraction_revisions (sandbox_id, id)
);

ALTER TABLE nexus.evidence
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN superseded_reason text;

REVOKE ALL ON
  nexus.document_extraction_revisions,
  nexus.document_extraction_fields,
  nexus.document_extraction_corrections
FROM PUBLIC;

GRANT SELECT, INSERT ON
  nexus.document_extraction_revisions,
  nexus.document_extraction_fields,
  nexus.document_extraction_corrections
TO nexus_api, nexus_worker;

GRANT UPDATE (superseded_at, superseded_reason)
  ON nexus.evidence TO nexus_api, nexus_worker;

GRANT SELECT ON nexus.document_page_texts TO nexus_api;

GRANT SELECT ON
  nexus.action_proposals,
  nexus.action_revisions,
  nexus.action_revision_evidence,
  nexus.action_executions
TO nexus_api;

GRANT UPDATE (state, updated_at) ON nexus.action_revisions TO nexus_api;
