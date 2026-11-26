\set ON_ERROR_STOP on

\getenv nexus_migrator_password NEXUS_MIGRATOR_PASSWORD
\getenv nexus_api_password NEXUS_API_PASSWORD
\getenv nexus_worker_password NEXUS_WORKER_PASSWORD
\getenv enterprise_migrator_password ENTERPRISE_MIGRATOR_PASSWORD
\getenv enterprise_app_password ENTERPRISE_APP_PASSWORD

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  'nexus_migrator', :'nexus_migrator_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_migrator')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  'nexus_api', :'nexus_api_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_api')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  'nexus_worker', :'nexus_worker_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_worker')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  'enterprise_migrator', :'enterprise_migrator_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_migrator')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  'enterprise_app', :'enterprise_app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_app')
\gexec

ALTER ROLE nexus_migrator PASSWORD :'nexus_migrator_password';
ALTER ROLE nexus_api PASSWORD :'nexus_api_password';
ALTER ROLE nexus_worker PASSWORD :'nexus_worker_password';
ALTER ROLE enterprise_migrator PASSWORD :'enterprise_migrator_password';
ALTER ROLE enterprise_app PASSWORD :'enterprise_app_password';

CREATE SCHEMA IF NOT EXISTS nexus;
CREATE SCHEMA IF NOT EXISTS enterprise;

ALTER SCHEMA nexus OWNER TO nexus_migrator;
ALTER SCHEMA enterprise OWNER TO enterprise_migrator;

ALTER ROLE nexus_migrator SET search_path = nexus, pg_catalog;
ALTER ROLE nexus_api SET search_path = nexus, pg_catalog;
ALTER ROLE nexus_worker SET search_path = nexus, pg_catalog;
ALTER ROLE enterprise_migrator SET search_path = enterprise, pg_catalog;
ALTER ROLE enterprise_app SET search_path = enterprise, pg_catalog;

REVOKE ALL ON SCHEMA nexus FROM PUBLIC;
REVOKE ALL ON SCHEMA enterprise FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA nexus TO nexus_api, nexus_worker;
GRANT USAGE ON SCHEMA enterprise TO enterprise_app;

SELECT format('REVOKE CREATE, TEMP ON DATABASE %I FROM PUBLIC', current_database())
\gexec
SELECT format('GRANT TEMP ON DATABASE %I TO nexus_migrator, enterprise_migrator', current_database())
\gexec

CREATE EXTENSION IF NOT EXISTS vector SCHEMA nexus;

DO $$
BEGIN
  IF (SELECT extversion FROM pg_extension WHERE extname = 'vector') IS DISTINCT FROM '0.8.7' THEN
    RAISE EXCEPTION 'pgvector extension version mismatch; expected 0.8.7';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'vector' AND n.nspname = 'nexus'
  ) THEN
    RAISE EXCEPTION 'pgvector extension must be installed in the nexus schema';
  END IF;
END
$$;
