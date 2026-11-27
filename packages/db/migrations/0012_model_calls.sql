CREATE TABLE nexus.budget_accounts (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes (id),
  owner_kind text NOT NULL,
  owner_id text NOT NULL,
  parent_account_id uuid,
  depth integer NOT NULL,
  cap_microusd bigint NOT NULL,
  used_microusd bigint NOT NULL DEFAULT 0,
  reserved_microusd bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT budget_accounts_kind_check CHECK (
    owner_kind IN ('case', 'run', 'document', 'evaluation', 'assistant', 'briefing', 'indexing')
  ),
  CONSTRAINT budget_accounts_state_check CHECK (state IN ('active', 'closed')),
  CONSTRAINT budget_accounts_amounts_check CHECK (
    cap_microusd >= 0 AND used_microusd >= 0 AND reserved_microusd >= 0
  ),
  CONSTRAINT budget_accounts_depth_check CHECK (depth BETWEEN 0 AND 3),
  CONSTRAINT budget_accounts_sandbox_owner_key UNIQUE (sandbox_id, owner_kind, owner_id),
  CONSTRAINT budget_accounts_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT budget_accounts_parent_fk FOREIGN KEY (sandbox_id, parent_account_id)
    REFERENCES nexus.budget_accounts (sandbox_id, id)
);

CREATE INDEX budget_accounts_parent_idx
  ON nexus.budget_accounts (sandbox_id, parent_account_id);

CREATE TABLE nexus.model_calls (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL,
  budget_account_id uuid NOT NULL,
  gateway_invocation_id uuid NOT NULL,
  physical_attempt integer NOT NULL,
  workflow_run_id uuid,
  role text NOT NULL,
  output_schema_id text NOT NULL,
  schema_version integer NOT NULL,
  prompt_version text NOT NULL,
  config_revision text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  mode text NOT NULL,
  replay_key text,
  request_hash text NOT NULL,
  state text NOT NULL,
  reserved_microusd bigint NOT NULL,
  settled_microusd bigint,
  reservations jsonb NOT NULL,
  usage jsonb,
  failure_code text,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_calls_state_check CHECK (state IN ('reserved', 'settled', 'failed', 'uncertain')),
  CONSTRAINT model_calls_mode_check CHECK (mode IN ('replay', 'live')),
  CONSTRAINT model_calls_attempt_check CHECK (physical_attempt BETWEEN 1 AND 2),
  CONSTRAINT model_calls_schema_version_check CHECK (schema_version >= 1),
  CONSTRAINT model_calls_amounts_check CHECK (
    reserved_microusd >= 0 AND (settled_microusd IS NULL OR settled_microusd >= 0)
  ),
  CONSTRAINT model_calls_hashes_check CHECK (
    request_hash ~ '^[a-f0-9]{64}$'
    AND (replay_key IS NULL OR replay_key ~ '^[a-f0-9]{64}$')
    AND prompt_version ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT model_calls_reservations_check CHECK (
    jsonb_typeof(reservations) = 'array' AND jsonb_array_length(reservations) BETWEEN 1 AND 4
  ),
  CONSTRAINT model_calls_sandbox_id_id_key UNIQUE (sandbox_id, id),
  CONSTRAINT model_calls_invocation_attempt_key UNIQUE (sandbox_id, gateway_invocation_id, physical_attempt),
  CONSTRAINT model_calls_account_fk FOREIGN KEY (sandbox_id, budget_account_id)
    REFERENCES nexus.budget_accounts (sandbox_id, id),
  CONSTRAINT model_calls_run_fk FOREIGN KEY (sandbox_id, workflow_run_id)
    REFERENCES nexus.workflow_runs (sandbox_id, id)
);

CREATE INDEX model_calls_account_idx
  ON nexus.model_calls (sandbox_id, budget_account_id, created_at);
CREATE INDEX model_calls_run_idx
  ON nexus.model_calls (sandbox_id, workflow_run_id, created_at);

REVOKE ALL ON nexus.budget_accounts, nexus.model_calls FROM PUBLIC;

-- The worker owns account creation and every spend mutation. The API role may
-- read the ledger for display but cannot create an account or change totals
-- outside the worker-owned transaction path.
GRANT SELECT ON nexus.budget_accounts TO nexus_api;
GRANT SELECT, INSERT ON nexus.budget_accounts TO nexus_worker;
GRANT UPDATE (used_microusd, reserved_microusd, state, updated_at)
  ON nexus.budget_accounts TO nexus_worker;

GRANT SELECT ON nexus.model_calls TO nexus_api;
GRANT SELECT, INSERT ON nexus.model_calls TO nexus_worker;
GRANT UPDATE (state, settled_microusd, usage, failure_code, diagnostics, settled_at)
  ON nexus.model_calls TO nexus_worker;
