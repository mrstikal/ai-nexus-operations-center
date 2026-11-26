ALTER TABLE enterprise.event_outbox
  DROP CONSTRAINT IF EXISTS event_outbox_aggregate_type_check;

ALTER TABLE enterprise.event_outbox
  ADD CONSTRAINT event_outbox_aggregate_type_check CHECK (
    aggregate_type IN (
      'inventory',
      'communication',
      'purchase_order',
      'supplier',
      'invoice'
    )
  );

REVOKE UPDATE ON enterprise.event_outbox FROM enterprise_app;
GRANT UPDATE (status, attempt_count, next_attempt_at, version, updated_at)
  ON enterprise.event_outbox TO enterprise_app;
