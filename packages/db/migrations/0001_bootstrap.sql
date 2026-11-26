CREATE TABLE IF NOT EXISTS nexus.infrastructure_metadata (
  metadata_key text PRIMARY KEY,
  metadata_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO nexus.infrastructure_metadata (metadata_key, metadata_value)
VALUES ('bootstrap', 'F02')
ON CONFLICT (metadata_key) DO UPDATE
SET metadata_value = EXCLUDED.metadata_value,
    updated_at = clock_timestamp();
