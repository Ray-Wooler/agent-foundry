BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE agent_version_status AS ENUM (
  'DRAFT','CANDIDATE','VALIDATED','EVALUATED','CERTIFIED','RELEASED',
  'REJECTED','SUPERSEDED','RETIRED','QUARANTINED'
);

CREATE TYPE evaluation_outcome AS ENUM ('PASS','PARTIAL','FAIL','NOT_APPLICABLE','NOT_TESTED');

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_id text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  class text NOT NULL,
  category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  version text NOT NULL,
  status agent_version_status NOT NULL DEFAULT 'DRAFT',
  aps_version text NOT NULL,
  content_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  UNIQUE(agent_id, version),
  CHECK (
    (status = 'DRAFT' AND content_sha256 IS NULL)
    OR
    (status <> 'DRAFT' AND content_sha256 ~ '^[a-f0-9]{64}$')
  )
);

CREATE TABLE aps_specifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL UNIQUE REFERENCES agent_versions(id) ON DELETE RESTRICT,
  document jsonb NOT NULL,
  sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE capability_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_id uuid NOT NULL REFERENCES capabilities(id) ON DELETE RESTRICT,
  version text NOT NULL,
  definition jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(capability_id, version)
);

CREATE TABLE agent_capabilities (
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  capability_version_id uuid NOT NULL REFERENCES capability_versions(id) ON DELETE RESTRICT,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(agent_version_id, capability_version_id)
);

CREATE TABLE source_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL,
  title text,
  uri text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  rights_status text NOT NULL DEFAULT 'UNVERIFIED',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  source_artifact_id uuid REFERENCES source_artifacts(id) ON DELETE RESTRICT,
  relation text NOT NULL,
  transformation jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_suites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_key text NOT NULL,
  version text NOT NULL,
  name text NOT NULL,
  definition jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(suite_key, version)
);

CREATE TABLE evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  evaluation_suite_id uuid NOT NULL REFERENCES evaluation_suites(id) ON DELETE RESTRICT,
  outcome evaluation_outcome NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_run_id uuid NOT NULL REFERENCES evaluation_runs(id) ON DELETE RESTRICT,
  case_key text NOT NULL,
  outcome evaluation_outcome NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(evaluation_run_id, case_key)
);

CREATE TABLE compilations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  target text NOT NULL,
  compiler_version text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_location text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_version_id, target, compiler_version, artifact_sha256)
);

CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL UNIQUE REFERENCES agent_versions(id) ON DELETE RESTRICT,
  release_version text NOT NULL,
  integrity_sha256 text NOT NULL CHECK (integrity_sha256 ~ '^[a-f0-9]{64}$'),
  released_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE release_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  artifact_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  location text,
  UNIQUE(release_id, artifact_type, sha256)
);

CREATE TABLE audit_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  authority_reference text,
  correlation_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION require_initial_agent_version_draft()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'AgentVersion must be created in DRAFT state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_agent_version_initial_draft
BEFORE INSERT ON agent_versions
FOR EACH ROW EXECUTE FUNCTION require_initial_agent_version_draft();

CREATE OR REPLACE FUNCTION validate_agent_version_promotion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  aps_digest text;
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status <> 'DRAFT' THEN
    SELECT sha256 INTO aps_digest
    FROM aps_specifications
    WHERE agent_version_id = OLD.id;

    IF aps_digest IS NULL OR aps_digest !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'promotion requires canonical APS with valid SHA-256';
    END IF;

    IF NEW.content_sha256 IS DISTINCT FROM aps_digest THEN
      RAISE EXCEPTION 'AgentVersion content_sha256 must equal canonical APS sha256';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_agent_version_promotion_valid
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION validate_agent_version_promotion();

CREATE OR REPLACE FUNCTION prevent_agent_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
    NEW.agent_id IS DISTINCT FROM OLD.agent_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.aps_version IS DISTINCT FROM OLD.aps_version OR
    NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
  ) THEN
    RAISE EXCEPTION 'non-DRAFT AgentVersion canonical identity/content is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_agent_version_immutable
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION prevent_agent_version_mutation();

CREATE OR REPLACE FUNCTION prevent_aps_mutation_after_draft()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status agent_version_status;
  version_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    version_id := NEW.agent_version_id;
  ELSE
    version_id := OLD.agent_version_id;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id THEN
    RAISE EXCEPTION 'APS specification cannot be moved between AgentVersions';
  END IF;

  SELECT status INTO current_status FROM agent_versions WHERE id = version_id;
  IF current_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'APS specification is immutable after DRAFT';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_aps_immutable
BEFORE INSERT OR UPDATE OR DELETE ON aps_specifications
FOR EACH ROW EXECUTE FUNCTION prevent_aps_mutation_after_draft();

CREATE OR REPLACE FUNCTION require_certified_release()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status agent_version_status;
BEGIN
  SELECT status INTO current_status FROM agent_versions WHERE id = NEW.agent_version_id;
  IF current_status NOT IN ('CERTIFIED','RELEASED') THEN
    RAISE EXCEPTION 'release requires CERTIFIED AgentVersion';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_release_certified
BEFORE INSERT ON releases
FOR EACH ROW EXECUTE FUNCTION require_certified_release();

CREATE OR REPLACE FUNCTION prevent_release_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'release record is immutable';
END $$;

CREATE TRIGGER trg_release_immutable
BEFORE UPDATE OR DELETE ON releases
FOR EACH ROW EXECUTE FUNCTION prevent_release_mutation();

CREATE OR REPLACE FUNCTION prevent_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only record cannot be updated or deleted';
END $$;

CREATE TRIGGER trg_provenance_append_only
BEFORE UPDATE OR DELETE ON provenance_records
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_audit_append_only
BEFORE UPDATE OR DELETE ON audit_records
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

COMMIT;
