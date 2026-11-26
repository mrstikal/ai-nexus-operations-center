ALTER TABLE nexus.workflow_runs
  ADD COLUMN resume_cause text NULL CHECK (
    resume_cause IS NULL OR resume_cause IN (
      'human_input', 'approval_completed', 'dependency_retry', 'budget_extension'
    )
  ),
  ADD COLUMN cancel_cause text NULL CHECK (
    cancel_cause IS NULL OR cancel_cause IN (
      'operator_request', 'dependency_failure', 'dependency_timeout', 'test'
    )
  ),
  ADD COLUMN partial_effects jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(partial_effects) = 'array');

CREATE UNIQUE INDEX workflow_runs_child_identity_key
  ON nexus.workflow_runs (sandbox_id, case_id, trigger_event_id);

CREATE TABLE nexus.workflow_dependencies (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  parent_run_id uuid NOT NULL,
  parent_case_id uuid NOT NULL,
  root_case_id uuid NOT NULL,
  child_case_id uuid NOT NULL,
  child_trigger_event_id uuid NOT NULL,
  linked_case_version integer NOT NULL CHECK (linked_case_version >= 0),
  state text NOT NULL CHECK (
    state IN ('waiting', 'resolved', 'escalated', 'expired', 'cancelled')
  ),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, parent_run_id, child_trigger_event_id),
  FOREIGN KEY (sandbox_id, parent_run_id)
    REFERENCES nexus.workflow_runs (sandbox_id, id),
  FOREIGN KEY (sandbox_id, parent_case_id)
    REFERENCES nexus.cases (sandbox_id, id),
  FOREIGN KEY (sandbox_id, root_case_id)
    REFERENCES nexus.cases (sandbox_id, id),
  FOREIGN KEY (sandbox_id, child_case_id)
    REFERENCES nexus.cases (sandbox_id, id),
  FOREIGN KEY (sandbox_id, child_case_id, child_trigger_event_id)
    REFERENCES nexus.workflow_runs (sandbox_id, case_id, trigger_event_id)
);

CREATE UNIQUE INDEX workflow_dependencies_active_parent_key
  ON nexus.workflow_dependencies (parent_run_id)
  WHERE state = 'waiting';

CREATE INDEX workflow_dependencies_wait_idx
  ON nexus.workflow_dependencies (state, expires_at);

REVOKE ALL ON nexus.workflow_dependencies FROM PUBLIC;

GRANT INSERT ON nexus.event_outbox TO nexus_worker;
GRANT SELECT, INSERT ON nexus.workflow_dependencies TO nexus_worker;
GRANT UPDATE (state, resolved_at, updated_at)
  ON nexus.workflow_dependencies TO nexus_worker;

GRANT SELECT ON nexus.workflow_dependencies TO nexus_api;
GRANT UPDATE (state, resolved_at, updated_at)
  ON nexus.workflow_dependencies TO nexus_api;

GRANT UPDATE (resume_cause, cancel_cause, partial_effects)
  ON nexus.workflow_runs TO nexus_worker;
GRANT UPDATE (
  status, wait_reason, resume_cause, cancel_cause, partial_effects,
  last_error, version, updated_at
) ON nexus.workflow_runs TO nexus_api;

GRANT SELECT, INSERT ON nexus.workflow_jobs TO nexus_api;
GRANT UPDATE (
  state, lease_owner, lease_expires_at, attempt_count, available_at,
  last_error, version, updated_at
) ON nexus.workflow_jobs TO nexus_api;

GRANT UPDATE (status, error_class, version, updated_at)
  ON nexus.workflow_steps TO nexus_api;
