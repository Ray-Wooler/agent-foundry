BEGIN;

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('OWNER','ADMIN','EDITOR','VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  slug text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, slug)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE SEQUENCE agent_registry_seq START 1000;

ALTER TABLE source_artifacts
  ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  ADD COLUMN created_by_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  ADD COLUMN content_text text,
  ADD COLUMN media_type text NOT NULL DEFAULT 'text/plain';

CREATE TABLE promptforge_transformations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL REFERENCES source_artifacts(id) ON DELETE RESTRICT,
  agent_version_id uuid REFERENCES agent_versions(id) ON DELETE RESTRICT,
  requested_name text NOT NULL,
  requested_class text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED','PROCESSING','REQUIRES_REVIEW','FAILED')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  record jsonb,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_sha256 text CHECK (candidate_sha256 IS NULL OR candidate_sha256 ~ '^[a-f0-9]{64}$'),
  failure_reason text,
  created_by_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX idx_promptforge_transformations_queue
  ON promptforge_transformations(status, created_at)
  WHERE status IN ('QUEUED','PROCESSING');

CREATE OR REPLACE FUNCTION prevent_source_artifact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source artifact is immutable';
END $$;

CREATE TRIGGER trg_source_artifact_immutable
BEFORE UPDATE OR DELETE ON source_artifacts
FOR EACH ROW EXECUTE FUNCTION prevent_source_artifact_mutation();

COMMIT;
