BEGIN;

-- 0006 installs immutable-record triggers before these legacy columns exist.
-- Temporarily remove only those triggers for the one-time NULL backfill, then
-- recreate them unchanged below so historical rows remain immutable afterward.
DROP TRIGGER IF EXISTS trg_release_package_records_immutable ON release_package_records;
DROP TRIGGER IF EXISTS trg_publication_records_immutable ON publication_records;
DROP TRIGGER IF EXISTS trg_frankai_registration_records_immutable ON frankai_registration_records;

ALTER TABLE release_package_records
  ADD COLUMN idempotency_key text,
  ADD COLUMN package_manifest jsonb,
  ADD COLUMN package_content jsonb,
  ADD COLUMN historical_content_available boolean NOT NULL DEFAULT true,
  ADD COLUMN created_by_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT;

UPDATE release_package_records
SET idempotency_key='legacy-'||id::text,
    package_manifest=jsonb_build_object('legacy',true,'package_sha256',package_sha256),
    package_content=NULL,
    historical_content_available=false
WHERE idempotency_key IS NULL;

ALTER TABLE release_package_records
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN package_manifest SET NOT NULL,
  ADD CONSTRAINT release_package_records_idempotency_key_unique UNIQUE(idempotency_key),
  ADD CONSTRAINT release_package_records_agent_unique UNIQUE(agent_version_id);

ALTER TABLE publication_records
  ADD COLUMN idempotency_key text,
  ADD COLUMN publication_payload jsonb,
  ADD COLUMN status text NOT NULL DEFAULT 'PUBLISHED'
    CHECK (status IN ('PUBLISHED'));

UPDATE publication_records
SET idempotency_key='legacy-'||id::text,
    publication_payload=jsonb_build_object('legacy',true,'channel',channel)
WHERE idempotency_key IS NULL;

ALTER TABLE publication_records
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN publication_payload SET NOT NULL,
  ADD CONSTRAINT publication_records_idempotency_key_unique UNIQUE(idempotency_key);

ALTER TABLE frankai_registration_records
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_payload jsonb,
  ADD COLUMN response_payload jsonb,
  ADD COLUMN status text NOT NULL DEFAULT 'REGISTERED'
    CHECK (status IN ('REGISTERED'));

UPDATE frankai_registration_records
SET idempotency_key='legacy-'||id::text,
    request_payload=jsonb_build_object('legacy',true),
    response_payload=jsonb_build_object('legacy',true,'registration_reference',registration_reference)
WHERE idempotency_key IS NULL;

ALTER TABLE frankai_registration_records
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_payload SET NOT NULL,
  ALTER COLUMN response_payload SET NOT NULL,
  ADD CONSTRAINT frankai_registration_records_idempotency_key_unique UNIQUE(idempotency_key);

CREATE OR REPLACE FUNCTION validate_release_package_record_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_status agent_version_status;
  approval_decision release_approval_decision;
  lifecycle_approval text;
BEGIN
  SELECT av.status,ra.decision,l.release_approval_status
  INTO version_status,approval_decision,lifecycle_approval
  FROM agent_versions av
  JOIN release_approval_records ra ON ra.agent_version_id=av.id
  JOIN lifecycle_readiness l ON l.agent_version_id=av.id
  WHERE av.id=NEW.agent_version_id
    AND ra.id=NEW.release_approval_id;

  IF version_status IS DISTINCT FROM 'CERTIFIED' THEN
    RAISE EXCEPTION 'packaging requires CERTIFIED AgentVersion';
  END IF;
  IF approval_decision IS DISTINCT FROM 'APPROVE'
     OR lifecycle_approval IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'packaging requires explicit APPROVE release authority';
  END IF;
  IF NEW.historical_content_available
     AND (NEW.package_content IS NULL OR encode(digest(convert_to(NEW.package_content::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM NEW.package_sha256) THEN
    RAISE EXCEPTION 'package_sha256 must equal stored package_content digest';
  END IF;
  IF NOT NEW.historical_content_available AND NEW.package_content IS NOT NULL THEN
    RAISE EXCEPTION 'historical package content is unavailable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_release_package_record_valid
BEFORE INSERT ON release_package_records
FOR EACH ROW EXECUTE FUNCTION validate_release_package_record_insert();

CREATE OR REPLACE FUNCTION validate_publication_record_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agent_version_id_value uuid;
  package_status text;
BEGIN
  SELECT rp.agent_version_id,l.packaging_status
  INTO agent_version_id_value,package_status
  FROM release_package_records rp
  JOIN lifecycle_readiness l ON l.agent_version_id=rp.agent_version_id
  WHERE rp.id=NEW.release_package_record_id;

  IF agent_version_id_value IS NULL OR package_status IS DISTINCT FROM 'PACKAGED' THEN
    RAISE EXCEPTION 'publication requires persisted PACKAGED release package';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_publication_record_valid
BEFORE INSERT ON publication_records
FOR EACH ROW EXECUTE FUNCTION validate_publication_record_insert();

CREATE OR REPLACE FUNCTION validate_frankai_registration_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agent_version_id_value uuid;
  publication_status_value text;
BEGIN
  SELECT rp.agent_version_id,l.publication_status
  INTO agent_version_id_value,publication_status_value
  FROM publication_records p
  JOIN release_package_records rp ON rp.id=p.release_package_record_id
  JOIN lifecycle_readiness l ON l.agent_version_id=rp.agent_version_id
  WHERE p.id=NEW.publication_record_id;

  IF agent_version_id_value IS NULL OR publication_status_value IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION 'FrankAI registration requires explicit PUBLISHED release';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_frankai_registration_valid
BEFORE INSERT ON frankai_registration_records
FOR EACH ROW EXECUTE FUNCTION validate_frankai_registration_insert();

CREATE TRIGGER trg_release_package_records_immutable
BEFORE UPDATE OR DELETE ON release_package_records
FOR EACH ROW EXECUTE FUNCTION prevent_certification_governance_mutation();

CREATE TRIGGER trg_publication_records_immutable
BEFORE UPDATE OR DELETE ON publication_records
FOR EACH ROW EXECUTE FUNCTION prevent_certification_governance_mutation();

CREATE TRIGGER trg_frankai_registration_records_immutable
BEFORE UPDATE OR DELETE ON frankai_registration_records
FOR EACH ROW EXECUTE FUNCTION prevent_certification_governance_mutation();

COMMIT;
