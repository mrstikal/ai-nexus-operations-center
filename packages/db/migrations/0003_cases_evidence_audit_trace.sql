CREATE TABLE nexus.sandboxes (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  business_effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz NULL
);

CREATE TABLE nexus.active_sandbox (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO nexus.sandboxes (id, name, status, business_effective_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Initial sandbox',
  'active',
  '2026-11-02T09:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO nexus.active_sandbox (singleton, sandbox_id)
VALUES (true, '00000000-0000-4000-8000-000000000001')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE nexus.cases (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  title text NOT NULL,
  summary text NULL,
  status text NOT NULL CHECK (
    status IN ('new','investigating','needs_input','needs_approval','executing','resolved','escalated','cancelled')
  ),
  version integer NOT NULL CHECK (version >= 0),
  terminal_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, id)
);

CREATE INDEX cases_sandbox_status_created_idx
  ON nexus.cases (sandbox_id, status, created_at DESC, id DESC);

CREATE TABLE nexus.case_entity_links (
  sandbox_id uuid NOT NULL,
  case_id uuid NOT NULL,
  system text NOT NULL CHECK (system IN ('nexus', 'enterprise')),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version >= 0),
  PRIMARY KEY (sandbox_id, case_id, system, entity_type, entity_id, entity_version),
  FOREIGN KEY (sandbox_id, case_id) REFERENCES nexus.cases(sandbox_id, id) ON DELETE CASCADE
);

CREATE TABLE nexus.sequence_counters (
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  stream text NOT NULL,
  last_value bigint NOT NULL CHECK (last_value >= 0),
  PRIMARY KEY (sandbox_id, stream)
);

CREATE TABLE nexus.evidence (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  case_id uuid NULL,
  kind text NOT NULL CHECK (
    kind IN ('enterprise_snapshot','document_page','policy_version','calculation','historical_memory','reconciliation_report')
  ),
  source_status text NOT NULL CHECK (source_status IN ('available', 'missing')),
  source_system text NULL CHECK (source_system IS NULL OR source_system IN ('nexus', 'enterprise')),
  source_type text NULL,
  source_id uuid NULL,
  source_version integer NULL CHECK (source_version IS NULL OR source_version >= 0),
  source_sandbox_id uuid NULL REFERENCES nexus.sandboxes(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  locator jsonb NULL,
  captured_facts jsonb NOT NULL,
  missing_reason text NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (sandbox_id, case_id) REFERENCES nexus.cases(sandbox_id, id)
);

CREATE INDEX evidence_sandbox_case_idx ON nexus.evidence (sandbox_id, case_id, captured_at DESC);

CREATE TABLE nexus.audit_events (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  actor_roles jsonb NOT NULL,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  run_id uuid NULL,
  action text NOT NULL,
  target_type text NULL,
  target_id uuid NULL,
  target_version text NULL,
  before_hash text NULL CHECK (before_hash IS NULL OR before_hash ~ '^[a-f0-9]{64}$'),
  after_hash text NULL CHECK (after_hash IS NULL OR after_hash ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, sequence)
);

CREATE INDEX audit_events_target_idx
  ON nexus.audit_events (sandbox_id, target_type, target_id, sequence DESC);

CREATE TABLE nexus.trace_events (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  run_id uuid NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, sequence)
);

CREATE INDEX trace_events_run_idx
  ON nexus.trace_events (sandbox_id, run_id, sequence ASC);

REVOKE ALL ON
  nexus.sandboxes, nexus.active_sandbox, nexus.cases, nexus.case_entity_links,
  nexus.sequence_counters, nexus.evidence, nexus.audit_events, nexus.trace_events
FROM PUBLIC;

GRANT SELECT ON nexus.sandboxes, nexus.active_sandbox TO nexus_api, nexus_worker;
GRANT SELECT, INSERT, UPDATE ON nexus.cases TO nexus_api, nexus_worker;
GRANT SELECT, INSERT ON nexus.case_entity_links TO nexus_api, nexus_worker;
GRANT SELECT, INSERT, UPDATE ON nexus.sequence_counters TO nexus_api, nexus_worker;
GRANT SELECT, INSERT ON nexus.evidence TO nexus_api, nexus_worker;
GRANT SELECT, INSERT ON nexus.audit_events TO nexus_api, nexus_worker;
GRANT SELECT, INSERT ON nexus.trace_events TO nexus_api, nexus_worker;
