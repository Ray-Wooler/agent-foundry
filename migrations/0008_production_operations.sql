BEGIN;

CREATE TABLE agent_workspace_bindings (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  bound_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agent_workspace_bindings(agent_id,workspace_id)
SELECT DISTINCT ON (av.agent_id) av.agent_id,p.workspace_id
FROM agent_versions av
JOIN promptforge_transformations t ON t.agent_version_id=av.id
JOIN projects p ON p.id=t.project_id
ORDER BY av.agent_id,t.created_at
ON CONFLICT (agent_id) DO NOTHING;

CREATE TABLE artifact_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_version_id uuid REFERENCES agent_versions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN (
    'SOURCE','APS','PROMPTFORGE_EVIDENCE','EVALUATION_EVIDENCE',
    'CERTIFICATION_EVIDENCE','RELEASE_PACKAGE','PUBLICATION_PAYLOAD',
    'FRANKAI_REGISTRATION'
  )),
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  storage_status text NOT NULL DEFAULT 'PENDING'
    CHECK (storage_status IN ('PENDING','STORED','FAILED','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  stored_at timestamptz
);

CREATE TABLE operational_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  job_type text NOT NULL CHECK (job_type IN ('STORE_ARTIFACT','VERIFY_ARTIFACT','BACKUP_VERIFY')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','RUNNING','RETRY','COMPLETED','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idx_operational_jobs_claim
  ON operational_jobs(status,available_at,created_at)
  WHERE status IN ('QUEUED','RETRY');

CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  process_type text NOT NULL,
  version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_type text NOT NULL CHECK (backup_type IN ('DATABASE','OBJECT_STORAGE','FULL')),
  status text NOT NULL CHECK (status IN ('STARTED','COMPLETED','FAILED','VERIFIED')),
  artifact_reference text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  verified_at timestamptz,
  error text
);

CREATE TABLE security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO','LOW','MODERATE','HIGH','CRITICAL')),
  subject_type text,
  subject_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_artifact_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size THEN
    RAISE EXCEPTION 'artifact object identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_artifact_identity_immutable
BEFORE UPDATE ON artifact_objects
FOR EACH ROW EXECUTE FUNCTION prevent_artifact_identity_mutation();

CREATE OR REPLACE FUNCTION prevent_agent_workspace_rebind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent workspace binding is immutable';
END $$;

CREATE TRIGGER trg_agent_workspace_binding_immutable
BEFORE UPDATE OR DELETE ON agent_workspace_bindings
FOR EACH ROW EXECUTE FUNCTION prevent_agent_workspace_rebind();

COMMIT;
