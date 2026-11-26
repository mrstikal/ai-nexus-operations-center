CREATE TABLE nexus.event_outbox (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  event_type text NOT NULL CHECK (
    event_type IN (
      'nexus.case.created.v1',
      'nexus.case.completed.v1',
      'nexus.document.ready.v1',
      'nexus.workflow.resume.v1',
      'nexus.action.requested.v1',
      'nexus.knowledge.changed.v1'
    )
  ),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  producer text NOT NULL CHECK (producer IN ('api', 'worker')),
  occurred_at timestamptz NOT NULL,
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  causation_id uuid NULL,
  aggregate_type text NOT NULL CHECK (
    aggregate_type IN ('case', 'workflow', 'action', 'document', 'knowledge')
  ),
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, id)
);

CREATE INDEX event_outbox_claim_idx
  ON nexus.event_outbox (status, next_attempt_at, created_at);

CREATE TABLE nexus.event_inbox (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  consumer_name text NOT NULL CHECK (char_length(consumer_name) BETWEEN 1 AND 100),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
  producer text NOT NULL CHECK (producer IN ('api', 'worker', 'enterprise-sim')),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  causation_id uuid NULL,
  occurred_at timestamptz NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  dispatch_state text NOT NULL CHECK (
    dispatch_state IN ('pending', 'scheduled', 'processed', 'dead')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (consumer_name, event_id)
);

CREATE INDEX event_inbox_dispatch_idx
  ON nexus.event_inbox (consumer_name, dispatch_state, next_attempt_at, received_at);

CREATE TABLE nexus.dead_letters (
  id uuid PRIMARY KEY,
  sandbox_id uuid NULL,
  consumer_name text NOT NULL CHECK (char_length(consumer_name) BETWEEN 1 AND 100),
  event_id uuid NULL,
  event_type text NULL CHECK (event_type IS NULL OR char_length(event_type) <= 100),
  exchange text NULL CHECK (exchange IS NULL OR char_length(exchange) <= 100),
  routing_key text NULL CHECK (routing_key IS NULL OR char_length(routing_key) <= 100),
  producer text NULL CHECK (producer IS NULL OR producer IN ('api', 'worker', 'enterprise-sim')),
  message_id text NULL CHECK (message_id IS NULL OR char_length(message_id) <= 200),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  body_bytes integer NOT NULL CHECK (body_bytes BETWEEN 0 AND 1048576),
  reason_code text NOT NULL CHECK (
    reason_code IN (
      'SCHEMA_INVALID',
      'UNKNOWN_EVENT',
      'PRODUCER_MISMATCH',
      'EXCHANGE_MISMATCH',
      'PAYLOAD_TOO_LARGE',
      'INTERNAL_ERROR',
      'UNKNOWN_SANDBOX'
    )
  ),
  reason_detail text NOT NULL CHECK (char_length(reason_detail) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (consumer_name, body_sha256)
);

CREATE INDEX dead_letters_created_idx ON nexus.dead_letters (created_at);

CREATE TABLE nexus.ingress_keys (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES nexus.sandboxes(id),
  route text NOT NULL CHECK (route ~ '^/[a-z0-9/_-]{1,100}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'workflow', 'service')),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  source_type text NOT NULL CHECK (source_type IN ('email', 'document', 'text')),
  source_identity text NOT NULL CHECK (char_length(source_identity) BETWEEN 1 AND 256),
  case_id uuid NOT NULL,
  event_id uuid NOT NULL,
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, actor_kind, actor_id, route, idempotency_key),
  UNIQUE (sandbox_id, route, source_type, source_identity),
  FOREIGN KEY (sandbox_id, case_id) REFERENCES nexus.cases (sandbox_id, id),
  FOREIGN KEY (sandbox_id, event_id) REFERENCES nexus.event_outbox (sandbox_id, id)
);

REVOKE ALL ON nexus.event_outbox, nexus.event_inbox, nexus.dead_letters, nexus.ingress_keys
  FROM PUBLIC;

GRANT SELECT, INSERT ON nexus.event_outbox TO nexus_api;
GRANT SELECT, INSERT ON nexus.ingress_keys TO nexus_api;

GRANT SELECT ON nexus.event_outbox TO nexus_worker;
GRANT UPDATE (status, attempt_count, next_attempt_at, last_error, version, updated_at)
  ON nexus.event_outbox TO nexus_worker;
GRANT SELECT, INSERT ON nexus.event_inbox TO nexus_worker;
GRANT UPDATE (dispatch_state, attempt_count, next_attempt_at, updated_at)
  ON nexus.event_inbox TO nexus_worker;
GRANT SELECT, INSERT ON nexus.dead_letters TO nexus_worker;
