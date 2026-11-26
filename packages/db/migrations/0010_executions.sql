CREATE TABLE nexus.action_executions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes (id),
  case_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  action_revision_id uuid NOT NULL,
  item_id uuid NOT NULL,
  command_kind text NOT NULL,
  execution_key text NOT NULL,
  plan_hash text NOT NULL,
  item_hash text NOT NULL,
  state text NOT NULL,
  authorization_basis text NOT NULL,
  policy_revision text,
  policy_content_hash text,
  committed_minor bigint,
  receipt_key text,
  receipt_id uuid,
  result_entity_type text,
  result_entity_id uuid,
  result_entity_version integer,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_executions_state_check CHECK (
    state IN ('pending', 'in_progress', 'succeeded', 'retryable_failure', 'unknown', 'permanent_failure', 'cancelled')
  ),
  CONSTRAINT action_executions_basis_check CHECK (authorization_basis IN ('human', 'policy_auto')),
  CONSTRAINT action_executions_plan_hash_check CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT action_executions_item_hash_check CHECK (item_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT action_executions_attempts_check CHECK (attempt_count >= 0),
  CONSTRAINT action_executions_committed_check CHECK (committed_minor IS NULL OR committed_minor >= 0),
  CONSTRAINT action_executions_revision_item_key UNIQUE (sandbox_id, action_revision_id, item_id),
  CONSTRAINT action_executions_execution_key UNIQUE (sandbox_id, execution_key),
  CONSTRAINT action_executions_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT action_executions_case_fk FOREIGN KEY (sandbox_id, case_id)
    REFERENCES nexus.cases (sandbox_id, id),
  CONSTRAINT action_executions_proposal_fk FOREIGN KEY (sandbox_id, proposal_id)
    REFERENCES nexus.action_proposals (sandbox_id, id),
  CONSTRAINT action_executions_revision_fk FOREIGN KEY (sandbox_id, action_revision_id)
    REFERENCES nexus.action_revisions (sandbox_id, id)
);

CREATE INDEX action_executions_case_idx ON nexus.action_executions (sandbox_id, case_id);
CREATE INDEX action_executions_revision_idx ON nexus.action_executions (sandbox_id, action_revision_id);

CREATE TABLE nexus.action_execution_attempts (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  state text NOT NULL,
  request_hash text,
  execute_before timestamptz,
  authorization_valid_until timestamptz,
  error_code text,
  receipt_key text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_execution_attempts_state_check CHECK (
    state IN ('pending', 'in_progress', 'succeeded', 'retryable_failure', 'unknown', 'permanent_failure', 'cancelled')
  ),
  CONSTRAINT action_execution_attempts_number_check CHECK (attempt_number >= 1),
  CONSTRAINT action_execution_attempts_hash_check CHECK (request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT action_execution_attempts_execution_number_key UNIQUE (execution_id, attempt_number),
  CONSTRAINT action_execution_attempts_execution_fk FOREIGN KEY (sandbox_id, execution_id)
    REFERENCES nexus.action_executions (sandbox_id, id)
);

CREATE INDEX action_execution_attempts_execution_idx
  ON nexus.action_execution_attempts (sandbox_id, execution_id);

CREATE TABLE nexus.action_execution_receipts (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  receipt_key text NOT NULL,
  command_kind text NOT NULL,
  action_revision_id uuid NOT NULL,
  item_id uuid NOT NULL,
  plan_hash text NOT NULL,
  item_hash text NOT NULL,
  result_entity_type text NOT NULL,
  result_entity_id uuid NOT NULL,
  result_entity_version integer NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_execution_receipts_key UNIQUE (sandbox_id, receipt_key),
  CONSTRAINT action_execution_receipts_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT action_execution_receipts_execution_key UNIQUE (execution_id),
  CONSTRAINT action_execution_receipts_execution_fk FOREIGN KEY (sandbox_id, execution_id)
    REFERENCES nexus.action_executions (sandbox_id, id)
);

CREATE TABLE nexus.action_execution_entity_changes (
  sandbox_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  ordinal integer NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before_version integer,
  after_version integer NOT NULL,
  CONSTRAINT action_execution_entity_changes_pkey PRIMARY KEY (sandbox_id, receipt_id, ordinal),
  CONSTRAINT action_execution_entity_changes_receipt_fk FOREIGN KEY (sandbox_id, receipt_id)
    REFERENCES nexus.action_execution_receipts (sandbox_id, id)
);

CREATE INDEX action_execution_entity_changes_entity_idx
  ON nexus.action_execution_entity_changes (sandbox_id, entity_type, entity_id);

CREATE TABLE nexus.case_notes (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  case_id uuid NOT NULL,
  action_revision_id uuid NOT NULL,
  item_id uuid NOT NULL,
  text text NOT NULL,
  authorization_basis text NOT NULL,
  policy_revision text NOT NULL,
  policy_content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT case_notes_basis_check CHECK (authorization_basis = 'policy_auto'),
  CONSTRAINT case_notes_text_check CHECK (length(text) BETWEEN 1 AND 2000),
  CONSTRAINT case_notes_revision_item_key UNIQUE (action_revision_id, item_id),
  CONSTRAINT case_notes_case_fk FOREIGN KEY (sandbox_id, case_id)
    REFERENCES nexus.cases (sandbox_id, id)
);

CREATE INDEX case_notes_case_idx ON nexus.case_notes (sandbox_id, case_id, created_at);

REVOKE ALL ON
  nexus.action_executions, nexus.action_execution_attempts,
  nexus.action_execution_receipts, nexus.action_execution_entity_changes,
  nexus.case_notes
FROM PUBLIC;

GRANT SELECT ON
  nexus.action_executions, nexus.action_execution_attempts,
  nexus.action_execution_receipts, nexus.action_execution_entity_changes,
  nexus.case_notes
TO nexus_api;

GRANT SELECT, INSERT, UPDATE ON
  nexus.action_executions, nexus.action_execution_attempts
TO nexus_worker;
GRANT SELECT, INSERT ON
  nexus.action_execution_receipts, nexus.action_execution_entity_changes,
  nexus.case_notes
TO nexus_worker;
GRANT SELECT ON
  nexus.action_execution_receipts, nexus.action_execution_entity_changes,
  nexus.case_notes
TO nexus_api;

GRANT SELECT ON nexus.user_roles TO nexus_worker;
