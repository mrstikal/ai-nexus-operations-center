ALTER TABLE enterprise.purchase_orders
  ADD COLUMN source_purchase_order_id uuid NULL,
  ADD COLUMN expedite_charge_minor bigint NOT NULL DEFAULT 0
    CHECK (expedite_charge_minor >= 0 AND expedite_charge_minor <= 1000000000000);

ALTER TABLE enterprise.purchase_orders
  ADD CONSTRAINT purchase_orders_source_not_self_check
    CHECK (source_purchase_order_id IS NULL OR source_purchase_order_id <> id),
  ADD CONSTRAINT purchase_orders_source_order_fk
    FOREIGN KEY (sandbox_id, source_purchase_order_id)
    REFERENCES enterprise.purchase_orders (sandbox_id, id);

CREATE INDEX purchase_orders_sandbox_source_idx
  ON enterprise.purchase_orders (sandbox_id, source_purchase_order_id);

ALTER TABLE enterprise.purchase_order_lines
  ADD COLUMN agreement_id uuid NULL;

ALTER TABLE enterprise.purchase_order_lines
  ADD CONSTRAINT purchase_order_lines_agreement_fk
    FOREIGN KEY (sandbox_id, agreement_id)
    REFERENCES enterprise.agreements (sandbox_id, id);

CREATE INDEX purchase_order_lines_sandbox_agreement_idx
  ON enterprise.purchase_order_lines (sandbox_id, agreement_id);

CREATE TABLE enterprise.command_receipts (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 400),
  command_kind text NOT NULL CHECK (
    command_kind IN ('enterprise.create_purchase_order', 'enterprise.send_message')
  ),
  action_revision_id uuid NOT NULL,
  item_id uuid NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  item_hash text NOT NULL CHECK (item_hash ~ '^[a-f0-9]{64}$'),
  prior_receipt_keys text[] NOT NULL DEFAULT '{}',
  execute_before timestamptz NOT NULL,
  authorization_valid_until timestamptz NOT NULL,
  result_entity_type text NOT NULL CHECK (
    result_entity_type IN ('purchase_order', 'communication')
  ),
  result_entity_id uuid NOT NULL,
  result_entity_version integer NOT NULL CHECK (result_entity_version >= 1),
  status text NOT NULL CHECK (status = 'succeeded'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, idempotency_key),
  CHECK (
    idempotency_key =
      sandbox_id::text || ':' || action_revision_id::text || ':' ||
      item_id::text || ':' || command_kind
  ),
  CHECK (
    (command_kind = 'enterprise.create_purchase_order' AND
      result_entity_type = 'purchase_order') OR
    (command_kind = 'enterprise.send_message' AND
      result_entity_type = 'communication')
  )
);

CREATE INDEX command_receipts_sandbox_revision_idx
  ON enterprise.command_receipts (sandbox_id, action_revision_id);

CREATE INDEX command_receipts_sandbox_created_idx
  ON enterprise.command_receipts (sandbox_id, created_at, id);

CREATE TABLE enterprise.command_receipt_base_versions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  receipt_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 50),
  entity_type text NOT NULL CHECK (
    entity_type IN (
      'sandbox', 'supplier', 'product', 'customer', 'agreement',
      'purchase_order', 'inventory'
    )
  ),
  entity_id uuid NOT NULL,
  entity_reference text NULL CHECK (
    entity_reference IS NULL OR entity_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (receipt_id, ordinal),
  UNIQUE (receipt_id, entity_type, entity_id),
  FOREIGN KEY (sandbox_id, receipt_id)
    REFERENCES enterprise.command_receipts (sandbox_id, id)
);

CREATE TABLE enterprise.command_receipt_entity_changes (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  receipt_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
  entity_type text NOT NULL CHECK (
    entity_type IN (
      'purchase_order', 'purchase_order_line', 'inventory', 'communication'
    )
  ),
  entity_id uuid NOT NULL,
  before_version integer NULL CHECK (before_version >= 0),
  after_version integer NOT NULL CHECK (after_version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (receipt_id, ordinal),
  UNIQUE (receipt_id, entity_type, entity_id),
  CHECK (before_version IS NULL OR after_version = before_version + 1),
  FOREIGN KEY (sandbox_id, receipt_id)
    REFERENCES enterprise.command_receipts (sandbox_id, id)
);

CREATE TABLE enterprise.communications (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  recipient_supplier_id uuid NULL,
  recipient_customer_id uuid NULL,
  recipient_reference text NOT NULL CHECK (
    recipient_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  recipient_version integer NOT NULL CHECK (recipient_version >= 0),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  rendered_text text NOT NULL CHECK (char_length(rendered_text) BETWEEN 1 AND 5000),
  status text NOT NULL CHECK (status = 'simulated'),
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sandbox_id, id),
  CHECK (
    (recipient_supplier_id IS NOT NULL AND recipient_customer_id IS NULL) OR
    (recipient_supplier_id IS NULL AND recipient_customer_id IS NOT NULL)
  ),
  FOREIGN KEY (sandbox_id, recipient_supplier_id)
    REFERENCES enterprise.suppliers (sandbox_id, id),
  FOREIGN KEY (sandbox_id, recipient_customer_id)
    REFERENCES enterprise.customers (sandbox_id, id)
);

CREATE INDEX communications_sandbox_created_idx
  ON enterprise.communications (sandbox_id, created_at, id);

CREATE TABLE enterprise.communication_parts (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  communication_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 20),
  kind text NOT NULL CHECK (kind IN ('text', 'verified_claim')),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  claim_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (communication_id, ordinal),
  CHECK ((kind = 'verified_claim') = (claim_id IS NOT NULL)),
  FOREIGN KEY (sandbox_id, communication_id)
    REFERENCES enterprise.communications (sandbox_id, id)
);

CREATE TABLE enterprise.event_outbox (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  event_type text NOT NULL CHECK (
    event_type IN (
      'enterprise.inventory.changed.v1',
      'enterprise.communication.created.v1'
    )
  ),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  causation_id uuid NULL,
  aggregate_type text NOT NULL CHECK (
    aggregate_type IN ('inventory', 'communication')
  ),
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status = 'pending'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  origin_action_revision_id uuid NOT NULL,
  origin_item_id uuid NOT NULL,
  origin_receipt_id uuid NOT NULL,
  origin_receipt_key text NOT NULL,
  UNIQUE (sandbox_id, id),
  FOREIGN KEY (sandbox_id, origin_receipt_id)
    REFERENCES enterprise.command_receipts (sandbox_id, id),
  FOREIGN KEY (sandbox_id, origin_receipt_key)
    REFERENCES enterprise.command_receipts (sandbox_id, idempotency_key)
);

CREATE INDEX event_outbox_status_next_attempt_idx
  ON enterprise.event_outbox (status, next_attempt_at, created_at);

CREATE INDEX event_outbox_sandbox_origin_idx
  ON enterprise.event_outbox (sandbox_id, origin_receipt_id);

CREATE INDEX event_outbox_sandbox_aggregate_idx
  ON enterprise.event_outbox (sandbox_id, aggregate_type, aggregate_id);

REVOKE ALL ON enterprise.command_receipts FROM PUBLIC;
REVOKE ALL ON enterprise.command_receipt_base_versions FROM PUBLIC;
REVOKE ALL ON enterprise.command_receipt_entity_changes FROM PUBLIC;
REVOKE ALL ON enterprise.communications FROM PUBLIC;
REVOKE ALL ON enterprise.communication_parts FROM PUBLIC;
REVOKE ALL ON enterprise.event_outbox FROM PUBLIC;

GRANT INSERT, UPDATE ON enterprise.purchase_orders TO enterprise_app;
GRANT INSERT ON enterprise.purchase_order_lines TO enterprise_app;
GRANT UPDATE ON enterprise.inventory TO enterprise_app;

GRANT SELECT, INSERT ON enterprise.command_receipts TO enterprise_app;
GRANT SELECT, INSERT ON enterprise.command_receipt_base_versions TO enterprise_app;
GRANT SELECT, INSERT ON enterprise.command_receipt_entity_changes TO enterprise_app;
GRANT SELECT, INSERT ON enterprise.communications TO enterprise_app;
GRANT SELECT, INSERT ON enterprise.communication_parts TO enterprise_app;
GRANT SELECT, INSERT ON enterprise.event_outbox TO enterprise_app;
