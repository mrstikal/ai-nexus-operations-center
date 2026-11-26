ALTER TABLE enterprise.event_outbox
  DROP CONSTRAINT IF EXISTS event_outbox_event_type_check,
  DROP CONSTRAINT IF EXISTS event_outbox_type_check,
  DROP CONSTRAINT IF EXISTS event_outbox_status_check;

ALTER TABLE enterprise.event_outbox
  ADD CONSTRAINT event_outbox_type_check CHECK (
    event_type IN (
      'enterprise.supplier.delay.v1',
      'enterprise.inventory.changed.v1',
      'enterprise.order.changed.v1',
      'enterprise.invoice.changed.v1',
      'enterprise.communication.created.v1'
    )
  ),
  ADD CONSTRAINT event_outbox_status_check CHECK (
    status IN ('pending', 'publishing', 'published', 'failed')
  );

GRANT UPDATE ON enterprise.event_outbox TO enterprise_app;
