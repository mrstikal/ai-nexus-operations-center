ALTER TABLE enterprise.event_outbox
  ADD COLUMN last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 200);
