ALTER TABLE nexus.action_execution_attempts
  ADD CONSTRAINT action_execution_attempts_sandbox_id_id_key UNIQUE (sandbox_id, id);

CREATE TABLE nexus.execution_attempt_payloads (
  attempt_id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  base_expected_versions jsonb NOT NULL,
  prior_receipt_keys jsonb NOT NULL,
  command_kind text NOT NULL,
  receipt_key text NOT NULL,
  plan_hash text NOT NULL,
  item_hash text NOT NULL,
  execute_before timestamptz NOT NULL,
  authorization_valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT execution_attempt_payloads_attempt_fk FOREIGN KEY (sandbox_id, attempt_id)
    REFERENCES nexus.action_execution_attempts (sandbox_id, id),
  CONSTRAINT execution_attempt_payloads_execution_fk FOREIGN KEY (sandbox_id, execution_id)
    REFERENCES nexus.action_executions (sandbox_id, id)
);

CREATE TABLE nexus.execution_reconciliations (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  result text NOT NULL,
  receipt_key text,
  db_now timestamptz NOT NULL,
  detail text,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT execution_reconciliations_result_check CHECK (
    result IN ('unknown', 'absent_final', 'found')
  ),
  CONSTRAINT execution_reconciliations_execution_fk FOREIGN KEY (sandbox_id, execution_id)
    REFERENCES nexus.action_executions (sandbox_id, id),
  CONSTRAINT execution_reconciliations_attempt_fk FOREIGN KEY (sandbox_id, attempt_id)
    REFERENCES nexus.action_execution_attempts (sandbox_id, id)
);

CREATE INDEX execution_reconciliations_execution_idx
  ON nexus.execution_reconciliations (sandbox_id, execution_id, observed_at);

CREATE TABLE nexus.action_partial_effects (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  kind text NOT NULL,
  receipt_key text,
  item_id uuid NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_partial_effects_kind_check CHECK (kind IN ('succeeded', 'cancelled', 'unknown')),
  CONSTRAINT action_partial_effects_execution_key UNIQUE (execution_id),
  CONSTRAINT action_partial_effects_execution_fk FOREIGN KEY (sandbox_id, execution_id)
    REFERENCES nexus.action_executions (sandbox_id, id)
);

CREATE TABLE nexus.action_reanalysis_handoffs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  source_proposal_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  succeeded_receipt_keys jsonb NOT NULL,
  cancelled_item_ids jsonb NOT NULL,
  state text NOT NULL,
  created_proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_reanalysis_handoffs_state_check CHECK (state IN ('pending', 'consumed')),
  CONSTRAINT action_reanalysis_handoffs_revision_key UNIQUE (source_revision_id)
);

REVOKE ALL ON
  nexus.execution_attempt_payloads, nexus.execution_reconciliations,
  nexus.action_partial_effects, nexus.action_reanalysis_handoffs
FROM PUBLIC;

GRANT SELECT ON
  nexus.execution_attempt_payloads, nexus.execution_reconciliations,
  nexus.action_partial_effects
TO nexus_api;
GRANT SELECT, INSERT ON nexus.action_reanalysis_handoffs TO nexus_api;
GRANT SELECT, INSERT ON
  nexus.execution_attempt_payloads, nexus.execution_reconciliations,
  nexus.action_partial_effects, nexus.action_reanalysis_handoffs
TO nexus_worker;
GRANT UPDATE (state, updated_at) ON nexus.action_reanalysis_handoffs TO nexus_worker;

GRANT INSERT ON nexus.action_proposals TO nexus_worker;
GRANT UPDATE (current_revision_id, updated_at) ON nexus.action_proposals TO nexus_worker;
GRANT USAGE ON SEQUENCE nexus.action_proposals_sequence_seq TO nexus_worker;
GRANT INSERT ON nexus.action_revisions TO nexus_worker;
GRANT INSERT ON nexus.action_revision_evidence TO nexus_worker;

GRANT UPDATE (state, created_proposal_id, updated_at) ON nexus.action_reanalysis_handoffs TO nexus_api;
GRANT UPDATE (state, created_proposal_id, updated_at, succeeded_receipt_keys, cancelled_item_ids)
  ON nexus.action_reanalysis_handoffs TO nexus_worker;

CREATE TABLE nexus.action_case_cancellations (
  sandbox_id uuid NOT NULL,
  case_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_case_cancellations_pkey PRIMARY KEY (sandbox_id, case_id),
  CONSTRAINT action_case_cancellations_case_fk FOREIGN KEY (sandbox_id, case_id)
    REFERENCES nexus.cases (sandbox_id, id)
);
REVOKE ALL ON nexus.action_case_cancellations FROM PUBLIC;
GRANT SELECT ON nexus.action_case_cancellations TO nexus_api;
GRANT SELECT, INSERT ON nexus.action_case_cancellations TO nexus_worker;
GRANT INSERT ON nexus.action_case_cancellations TO nexus_api;
GRANT UPDATE (state, updated_at) ON nexus.action_executions TO nexus_api;
