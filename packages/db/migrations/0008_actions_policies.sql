CREATE TABLE nexus.policy_bundles (
  revision text PRIMARY KEY,
  schema_version integer NOT NULL,
  bundle jsonb NOT NULL,
  content_hash text NOT NULL,
  canonical_text_path text NOT NULL,
  canonical_text_hash text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT policy_bundles_schema_version_check CHECK (schema_version = 1),
  CONSTRAINT policy_bundles_content_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT policy_bundles_canonical_text_hash_check CHECK (canonical_text_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT policy_bundles_status_check CHECK (status IN ('active', 'superseded'))
);

CREATE TABLE nexus.action_proposals (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes (id),
  case_id uuid NOT NULL,
  current_revision_id uuid,
  status text NOT NULL,
  has_procurement boolean NOT NULL,
  created_by_kind text NOT NULL,
  created_by_id text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_proposals_status_check CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'rejected', 'superseded', 'expired', 'cancelled')
  ),
  CONSTRAINT action_proposals_version_check CHECK (version >= 0),
  CONSTRAINT action_proposals_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT action_proposals_case_fk FOREIGN KEY (sandbox_id, case_id)
    REFERENCES nexus.cases (sandbox_id, id)
);

CREATE UNIQUE INDEX action_proposals_open_procurement_key
  ON nexus.action_proposals (sandbox_id, case_id)
  WHERE has_procurement AND status IN ('draft', 'pending_approval', 'approved');

CREATE INDEX action_proposals_case_idx
  ON nexus.action_proposals (sandbox_id, case_id, created_at DESC);

CREATE TABLE nexus.action_revisions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  revision_number integer NOT NULL,
  state text NOT NULL,
  plan_hash text NOT NULL,
  items jsonb NOT NULL,
  required_roles jsonb NOT NULL,
  aggregate_impact_minor bigint,
  is_procurement boolean NOT NULL,
  policy_revision text NOT NULL,
  policy_content_hash text NOT NULL,
  rationale text NOT NULL,
  authored_by_kind text NOT NULL,
  authored_by_id text NOT NULL,
  authored_by_roles jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_revisions_number_check CHECK (revision_number >= 1),
  CONSTRAINT action_revisions_state_check CHECK (
    state IN ('draft', 'pending_approval', 'approved', 'rejected', 'superseded', 'expired', 'cancelled')
  ),
  CONSTRAINT action_revisions_plan_hash_check CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT action_revisions_policy_hash_check CHECK (policy_content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT action_revisions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT action_revisions_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT action_revisions_proposal_number_key UNIQUE (proposal_id, revision_number),
  CONSTRAINT action_revisions_proposal_fk FOREIGN KEY (sandbox_id, proposal_id)
    REFERENCES nexus.action_proposals (sandbox_id, id)
);

CREATE INDEX action_revisions_proposal_idx
  ON nexus.action_revisions (sandbox_id, proposal_id, revision_number DESC);

CREATE TABLE nexus.action_revision_evidence (
  sandbox_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  CONSTRAINT action_revision_evidence_pkey PRIMARY KEY (sandbox_id, revision_id, evidence_id),
  CONSTRAINT action_revision_evidence_revision_fk FOREIGN KEY (sandbox_id, revision_id)
    REFERENCES nexus.action_revisions (sandbox_id, id),
  CONSTRAINT action_revision_evidence_evidence_fk FOREIGN KEY (sandbox_id, evidence_id)
    REFERENCES nexus.evidence (sandbox_id, id)
);

CREATE TABLE nexus.action_proposal_idempotency (
  sandbox_id uuid NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  route text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  proposal_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_proposal_idempotency_pkey PRIMARY KEY (
    sandbox_id, actor_kind, actor_id, route, idempotency_key
  ),
  CONSTRAINT action_proposal_idempotency_request_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT action_proposal_idempotency_key_check CHECK (
    idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT action_proposal_idempotency_proposal_fk FOREIGN KEY (sandbox_id, proposal_id)
    REFERENCES nexus.action_proposals (sandbox_id, id)
);

ALTER TABLE nexus.action_proposals
  ADD CONSTRAINT action_proposals_current_revision_fk
  FOREIGN KEY (sandbox_id, current_revision_id)
  REFERENCES nexus.action_revisions (sandbox_id, id)
  DEFERRABLE INITIALLY DEFERRED;

REVOKE ALL ON
  nexus.policy_bundles, nexus.action_proposals, nexus.action_revisions,
  nexus.action_revision_evidence, nexus.action_proposal_idempotency
FROM PUBLIC;

GRANT SELECT, INSERT ON nexus.policy_bundles TO nexus_api;
GRANT SELECT ON nexus.policy_bundles TO nexus_worker;

GRANT SELECT, INSERT ON nexus.action_proposals TO nexus_api;
GRANT UPDATE (status, current_revision_id, has_procurement, version, updated_at)
  ON nexus.action_proposals TO nexus_api;
GRANT SELECT ON nexus.action_proposals TO nexus_worker;
GRANT UPDATE (status, version, updated_at)
  ON nexus.action_proposals TO nexus_worker;

GRANT SELECT, INSERT ON nexus.action_revisions TO nexus_api;
GRANT UPDATE (state, updated_at) ON nexus.action_revisions TO nexus_api;
GRANT SELECT ON nexus.action_revisions TO nexus_worker;
GRANT UPDATE (state, updated_at) ON nexus.action_revisions TO nexus_worker;

GRANT SELECT, INSERT ON nexus.action_revision_evidence TO nexus_api;
GRANT SELECT ON nexus.action_revision_evidence TO nexus_worker;

GRANT SELECT, INSERT ON nexus.action_proposal_idempotency TO nexus_api;
