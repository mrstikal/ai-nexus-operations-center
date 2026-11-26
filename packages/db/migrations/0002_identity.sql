CREATE TABLE nexus.users (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  password_params jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX users_username_lower_key ON nexus.users (lower(username));

CREATE TABLE nexus.user_roles (
  user_id uuid NOT NULL REFERENCES nexus.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (
    role IN ('viewer', 'operator', 'approver_ops', 'approver_finance', 'admin')
  ),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE nexus.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES nexus.users(id) ON DELETE CASCADE,
  token_digest text NOT NULL UNIQUE,
  csrf_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL
);

CREATE INDEX sessions_user_idx ON nexus.sessions (user_id);
CREATE INDEX sessions_expiry_idx ON nexus.sessions (expires_at);

CREATE TABLE nexus.preauth_challenges (
  id uuid PRIMARY KEY,
  token_digest text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL
);

CREATE INDEX preauth_challenges_expiry_idx ON nexus.preauth_challenges (expires_at);

CREATE OR REPLACE VIEW nexus.approver_role_view AS
SELECT
  u.id AS user_id,
  COALESCE(
    array_agg(ur.role ORDER BY ur.role) FILTER (WHERE ur.role IS NOT NULL),
    ARRAY[]::text[]
  ) AS roles,
  u.is_active
FROM nexus.users u
LEFT JOIN nexus.user_roles ur ON ur.user_id = u.id
GROUP BY u.id, u.is_active;

REVOKE ALL ON nexus.users, nexus.user_roles, nexus.sessions, nexus.preauth_challenges
  FROM PUBLIC;
REVOKE ALL ON nexus.approver_role_view FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON nexus.users TO nexus_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON nexus.user_roles TO nexus_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON nexus.sessions TO nexus_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON nexus.preauth_challenges TO nexus_api;
GRANT SELECT ON nexus.approver_role_view TO nexus_worker;
