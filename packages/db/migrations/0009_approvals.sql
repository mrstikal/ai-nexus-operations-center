ALTER TABLE nexus.action_proposals
  ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX action_proposals_sequence_key
  ON nexus.action_proposals (sequence);

CREATE TABLE nexus.approval_decisions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes (id),
  proposal_id uuid NOT NULL,
  action_revision_id uuid NOT NULL,
  plan_hash text NOT NULL,
  decision text NOT NULL,
  role text NOT NULL,
  required_roles jsonb NOT NULL,
  state text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  actor_roles jsonb NOT NULL,
  reason text,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_at timestamptz,
  CONSTRAINT approval_decisions_decision_check CHECK (decision IN ('approve', 'reject')),
  CONSTRAINT approval_decisions_state_check CHECK (state IN ('active', 'superseded')),
  CONSTRAINT approval_decisions_role_check CHECK (role IN ('approver_ops', 'approver_finance')),
  CONSTRAINT approval_decisions_actor_check CHECK (actor_kind = 'human'),
  CONSTRAINT approval_decisions_plan_hash_check CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT approval_decisions_reason_check CHECK (reason IS NULL OR length(reason) <= 2000),
  CONSTRAINT approval_decisions_required_roles_check CHECK (
    jsonb_typeof(required_roles) = 'array'
    AND required_roles <@ '["approver_ops","approver_finance"]'::jsonb
  ),
  CONSTRAINT approval_decisions_proposal_fk FOREIGN KEY (sandbox_id, proposal_id)
    REFERENCES nexus.action_proposals (sandbox_id, id),
  CONSTRAINT approval_decisions_revision_fk FOREIGN KEY (sandbox_id, action_revision_id)
    REFERENCES nexus.action_revisions (sandbox_id, id)
);

CREATE INDEX approval_decisions_revision_idx
  ON nexus.approval_decisions (sandbox_id, action_revision_id, decided_at);
CREATE INDEX approval_decisions_proposal_idx
  ON nexus.approval_decisions (sandbox_id, proposal_id, decided_at);
CREATE UNIQUE INDEX approval_decisions_active_role_key
  ON nexus.approval_decisions (sandbox_id, action_revision_id, role)
  WHERE decision = 'approve' AND state = 'active';
CREATE UNIQUE INDEX approval_decisions_active_actor_key
  ON nexus.approval_decisions (sandbox_id, action_revision_id, actor_id)
  WHERE decision = 'approve' AND state = 'active';
CREATE UNIQUE INDEX approval_decisions_active_reject_key
  ON nexus.approval_decisions (sandbox_id, action_revision_id)
  WHERE decision = 'reject' AND state = 'active';

CREATE TABLE nexus.action_command_idempotency (
  sandbox_id uuid NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  route text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_command_idempotency_pkey PRIMARY KEY (
    sandbox_id, actor_kind, actor_id, route, idempotency_key
  ),
  CONSTRAINT action_command_idempotency_key_check CHECK (
    idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT action_command_idempotency_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT action_command_idempotency_actor_check CHECK (actor_kind = 'human')
);

CREATE TABLE nexus.action_revision_requests (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  action_revision_id uuid NOT NULL,
  plan_hash text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  actor_roles jsonb NOT NULL,
  reason text NOT NULL,
  wait_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_revision_requests_kind_check CHECK (kind IN ('clarification', 'reanalysis')),
  CONSTRAINT action_revision_requests_state_check CHECK (state IN ('recorded', 'completed', 'superseded')),
  CONSTRAINT action_revision_requests_actor_check CHECK (actor_kind = 'human'),
  CONSTRAINT action_revision_requests_plan_hash_check CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT action_revision_requests_reason_check CHECK (length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT action_revision_requests_proposal_fk FOREIGN KEY (sandbox_id, proposal_id)
    REFERENCES nexus.action_proposals (sandbox_id, id),
  CONSTRAINT action_revision_requests_revision_fk FOREIGN KEY (sandbox_id, action_revision_id)
    REFERENCES nexus.action_revisions (sandbox_id, id),
  CONSTRAINT action_revision_requests_wait_run_fk FOREIGN KEY (sandbox_id, wait_run_id)
    REFERENCES nexus.workflow_runs (sandbox_id, id)
);

CREATE INDEX action_revision_requests_proposal_idx
  ON nexus.action_revision_requests (sandbox_id, proposal_id, created_at);
CREATE UNIQUE INDEX action_revision_requests_active_kind_key
  ON nexus.action_revision_requests (sandbox_id, action_revision_id, kind)
  WHERE state = 'recorded';

CREATE TABLE nexus.case_resolutions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  case_id uuid NOT NULL,
  case_version integer NOT NULL,
  kind text NOT NULL,
  reason text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  actor_roles jsonb NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT case_resolutions_kind_check CHECK (kind IN ('no_action')),
  CONSTRAINT case_resolutions_actor_check CHECK (actor_kind = 'human'),
  CONSTRAINT case_resolutions_reason_check CHECK (length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT case_resolutions_case_version_check CHECK (case_version > 0),
  CONSTRAINT case_resolutions_case_fk FOREIGN KEY (sandbox_id, case_id)
    REFERENCES nexus.cases (sandbox_id, id)
);

CREATE INDEX case_resolutions_case_idx
  ON nexus.case_resolutions (sandbox_id, case_id, resolved_at);

REVOKE ALL ON
  nexus.approval_decisions, nexus.action_command_idempotency,
  nexus.action_revision_requests, nexus.case_resolutions
FROM PUBLIC;

GRANT SELECT, INSERT ON nexus.approval_decisions TO nexus_api;
GRANT UPDATE (state, superseded_at) ON nexus.approval_decisions TO nexus_api;
GRANT SELECT ON nexus.approval_decisions TO nexus_worker;
GRANT UPDATE (state, superseded_at) ON nexus.approval_decisions TO nexus_worker;

GRANT SELECT, INSERT ON nexus.action_command_idempotency TO nexus_api;

GRANT SELECT, INSERT ON nexus.action_revision_requests TO nexus_api;
GRANT UPDATE (state, updated_at) ON nexus.action_revision_requests TO nexus_api;
GRANT SELECT ON nexus.action_revision_requests TO nexus_worker;

GRANT SELECT, INSERT ON nexus.case_resolutions TO nexus_api;
GRANT SELECT ON nexus.case_resolutions TO nexus_worker;

GRANT USAGE ON SEQUENCE nexus.action_proposals_sequence_seq TO nexus_api;
