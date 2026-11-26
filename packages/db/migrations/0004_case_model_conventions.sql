ALTER TABLE nexus.sandboxes
  ADD COLUMN version integer NOT NULL DEFAULT 0,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE nexus.active_sandbox
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN version integer NOT NULL DEFAULT 0;

ALTER TABLE nexus.case_entity_links
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE UNIQUE INDEX active_sandbox_id_key ON nexus.active_sandbox (id);
CREATE UNIQUE INDEX case_entity_links_id_key ON nexus.case_entity_links (id);
