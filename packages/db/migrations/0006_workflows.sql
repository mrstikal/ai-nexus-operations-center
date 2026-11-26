CREATE TABLE nexus.workflow_runs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  case_id uuid NOT NULL,
  inbox_id uuid NOT NULL REFERENCES nexus.event_inbox(id),
  trigger_event_id uuid NOT NULL,
  trigger_event_type text NOT NULL CHECK (char_length(trigger_event_type) BETWEEN 1 AND 100),
  definition_name text NOT NULL CHECK (char_length(definition_name) BETWEEN 1 AND 100),
  definition_version text NOT NULL CHECK (char_length(definition_version) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (
    status IN (
      'queued', 'running', 'waiting_input', 'waiting_approval',
      'waiting_dependency', 'blocked', 'budget_exhausted', 'completed',
      'failed', 'cancel_requested', 'cancelled'
    )
  ),
  ingress jsonb NOT NULL CHECK (jsonb_typeof(ingress) = 'object'),
  ingress_hash text NOT NULL CHECK (ingress_hash ~ '^[a-f0-9]{64}$'),
  effective_at timestamptz NOT NULL,
  wait_reason jsonb NULL CHECK (wait_reason IS NULL OR jsonb_typeof(wait_reason) = 'object'),
  policy_revision text NOT NULL CHECK (char_length(policy_revision) BETWEEN 1 AND 100),
  model_revision text NOT NULL CHECK (char_length(model_revision) BETWEEN 1 AND 100),
  config_revision text NOT NULL CHECK (char_length(config_revision) BETWEEN 1 AND 100),
  prompt_revision text NULL CHECK (prompt_revision IS NULL OR char_length(prompt_revision) <= 100),
  active_ms_limit integer NOT NULL CHECK (active_ms_limit > 0),
  active_ms_used integer NOT NULL DEFAULT 0 CHECK (active_ms_used >= 0),
  deadline_at timestamptz NOT NULL,
  cancel_requested boolean NOT NULL DEFAULT false,
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, trigger_event_id),
  FOREIGN KEY (sandbox_id, case_id) REFERENCES nexus.cases (sandbox_id, id)
);

CREATE INDEX workflow_runs_status_idx
  ON nexus.workflow_runs (sandbox_id, status, created_at);

CREATE TABLE nexus.workflow_steps (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_key text NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  step_kind text NOT NULL CHECK (step_kind IN ('pure', 'read', 'external')),
  status text NOT NULL CHECK (
    status IN (
      'pending', 'running', 'succeeded', 'retryable_failure',
      'permanent_failure', 'waiting', 'cancelled'
    )
  ),
  input_hash text NULL CHECK (input_hash IS NULL OR input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text NULL CHECK (output_hash IS NULL OR output_hash ~ '^[a-f0-9]{64}$'),
  output jsonb NULL CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 3),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 3),
  error_class text NULL CHECK (error_class IS NULL OR char_length(error_class) <= 100),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, step_key),
  FOREIGN KEY (sandbox_id, run_id) REFERENCES nexus.workflow_runs (sandbox_id, id)
);

CREATE INDEX workflow_steps_run_status_idx
  ON nexus.workflow_steps (run_id, status);

CREATE TABLE nexus.workflow_step_attempts (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_id uuid NOT NULL REFERENCES nexus.workflow_steps(id),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  status text NOT NULL CHECK (
    status IN (
      'running', 'succeeded', 'retryable_failure',
      'permanent_failure', 'waiting', 'cancelled'
    )
  ),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text NULL CHECK (output_hash IS NULL OR output_hash ~ '^[a-f0-9]{64}$'),
  output jsonb NULL CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  error_class text NULL CHECK (error_class IS NULL OR char_length(error_class) <= 100),
  model_revision text NULL CHECK (model_revision IS NULL OR char_length(model_revision) <= 100),
  policy_revision text NULL CHECK (policy_revision IS NULL OR char_length(policy_revision) <= 100),
  config_revision text NULL CHECK (config_revision IS NULL OR char_length(config_revision) <= 100),
  prompt_revision text NULL CHECK (prompt_revision IS NULL OR char_length(prompt_revision) <= 100),
  lease_fencing_token bigint NOT NULL CHECK (lease_fencing_token >= 0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (step_id, attempt_no),
  FOREIGN KEY (sandbox_id, run_id) REFERENCES nexus.workflow_runs (sandbox_id, id)
);

CREATE INDEX workflow_step_attempts_run_idx
  ON nexus.workflow_step_attempts (run_id, created_at);

CREATE UNIQUE INDEX workflow_step_attempts_sandbox_id_key
  ON nexus.workflow_step_attempts (sandbox_id, id);

CREATE UNIQUE INDEX evidence_sandbox_id_key ON nexus.evidence (sandbox_id, id);

CREATE TABLE nexus.workflow_attempt_evidence (
  attempt_id uuid NOT NULL,
  sandbox_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attempt_id, evidence_id),
  FOREIGN KEY (sandbox_id, attempt_id)
    REFERENCES nexus.workflow_step_attempts (sandbox_id, id),
  FOREIGN KEY (sandbox_id, evidence_id)
    REFERENCES nexus.evidence (sandbox_id, id)
);


CREATE TABLE nexus.workflow_jobs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  run_id uuid NOT NULL,
  state text NOT NULL CHECK (
    state IN ('pending', 'leased', 'succeeded', 'failed', 'cancelled')
  ),
  lease_owner text NULL CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 200),
  lease_expires_at timestamptz NULL,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  FOREIGN KEY (sandbox_id, run_id) REFERENCES nexus.workflow_runs (sandbox_id, id)
);

CREATE UNIQUE INDEX workflow_jobs_active_run_key
  ON nexus.workflow_jobs (run_id)
  WHERE state IN ('pending', 'leased');

CREATE INDEX workflow_jobs_claim_idx
  ON nexus.workflow_jobs (state, available_at, created_at);

REVOKE ALL ON
  nexus.workflow_runs, nexus.workflow_steps, nexus.workflow_step_attempts,
  nexus.workflow_attempt_evidence, nexus.workflow_jobs
FROM PUBLIC;

GRANT SELECT, INSERT ON nexus.workflow_runs TO nexus_worker;
GRANT UPDATE (
  status, wait_reason, active_ms_used, cancel_requested, last_error, version, updated_at
) ON nexus.workflow_runs TO nexus_worker;
GRANT SELECT ON nexus.workflow_runs TO nexus_api;

GRANT SELECT, INSERT ON nexus.workflow_steps TO nexus_worker;
GRANT UPDATE (
  status, input_hash, output_hash, output, evidence_refs, attempt_count,
  error_class, started_at, finished_at, version, updated_at
) ON nexus.workflow_steps TO nexus_worker;
GRANT SELECT ON nexus.workflow_steps TO nexus_api;

GRANT SELECT, INSERT ON nexus.workflow_step_attempts TO nexus_worker;
GRANT SELECT ON nexus.workflow_step_attempts TO nexus_api;

GRANT SELECT, INSERT ON nexus.workflow_attempt_evidence TO nexus_worker;
GRANT SELECT ON nexus.workflow_attempt_evidence TO nexus_api;

GRANT SELECT, INSERT ON nexus.workflow_jobs TO nexus_worker;
GRANT UPDATE (
  state, lease_owner, lease_expires_at, fencing_token, attempt_count,
  available_at, last_error, version, updated_at
) ON nexus.workflow_jobs TO nexus_worker;
