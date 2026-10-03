BEGIN;

-- Replace the Phase 4 lifecycle blocker with Phase 5 certification-aware lifecycle rules.
DROP TRIGGER IF EXISTS trg_phase4_evaluation_lifecycle ON agent_versions;

CREATE TYPE certification_decision AS ENUM ('CERTIFY','DENY');
CREATE TYPE release_approval_decision AS ENUM ('APPROVE','DENY');

CREATE TABLE certification_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL UNIQUE REFERENCES agent_versions(id) ON DELETE RESTRICT,
  evaluation_plan_id uuid NOT NULL REFERENCES evaluation_plans(id) ON DELETE RESTRICT,
  readiness_decision_id uuid NOT NULL UNIQUE REFERENCES certification_readiness_decisions(id) ON DELETE RESTRICT,
  certifier_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  certifier_role text NOT NULL CHECK (certifier_role IN ('OWNER','ADMIN')),
  decision certification_decision NOT NULL,
  rationale text NOT NULL,
  evidence_bundle jsonb NOT NULL,
  canonical_aps_sha256 text NOT NULL CHECK (canonical_aps_sha256 ~ '^[a-f0-9]{64}$'),
  evaluation_aggregate evaluation_outcome NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE release_approval_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL UNIQUE REFERENCES agent_versions(id) ON DELETE RESTRICT,
  certification_record_id uuid NOT NULL UNIQUE REFERENCES certification_records(id) ON DELETE RESTRICT,
  approver_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  approver_role text NOT NULL CHECK (approver_role IN ('OWNER','ADMIN')),
  decision release_approval_decision NOT NULL,
  rationale text NOT NULL,
  intended_distribution text NOT NULL,
  rights_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE release_package_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  release_approval_id uuid NOT NULL REFERENCES release_approval_records(id) ON DELETE RESTRICT,
  release_id uuid UNIQUE REFERENCES releases(id) ON DELETE RESTRICT,
  package_sha256 text NOT NULL UNIQUE CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
  package_location text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publication_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_package_record_id uuid NOT NULL REFERENCES release_package_records(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  external_reference text,
  published_by_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_package_record_id,channel)
);

CREATE TABLE frankai_registration_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_record_id uuid NOT NULL UNIQUE REFERENCES publication_records(id) ON DELETE RESTRICT,
  registration_reference text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lifecycle_readiness
  ADD COLUMN certification_decision_status text NOT NULL DEFAULT 'NOT_REVIEWED'
    CHECK (certification_decision_status IN ('NOT_REVIEWED','CERTIFIED','DENIED')),
  ADD COLUMN release_approval_status text NOT NULL DEFAULT 'NOT_REVIEWED'
    CHECK (release_approval_status IN ('NOT_REVIEWED','APPROVED','DENIED')),
  ADD COLUMN packaging_status text NOT NULL DEFAULT 'NOT_PACKAGED'
    CHECK (packaging_status IN ('NOT_PACKAGED','PACKAGED')),
  ADD COLUMN publication_status text NOT NULL DEFAULT 'NOT_PUBLISHED'
    CHECK (publication_status IN ('NOT_PUBLISHED','PUBLISHED')),
  ADD COLUMN frankai_registration_status text NOT NULL DEFAULT 'NOT_REGISTERED'
    CHECK (frankai_registration_status IN ('NOT_REGISTERED','REGISTERED'));

CREATE OR REPLACE FUNCTION prevent_certification_governance_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'certification/release governance evidence is immutable';
END $$;

CREATE TRIGGER trg_certification_records_immutable
BEFORE UPDATE OR DELETE ON certification_records
FOR EACH ROW EXECUTE FUNCTION prevent_certification_governance_mutation();

CREATE TRIGGER trg_release_approval_records_immutable
BEFORE UPDATE OR DELETE ON release_approval_records
FOR EACH ROW EXECUTE FUNCTION prevent_certification_governance_mutation();

CREATE TRIGGER trg_release_package_records_immutable
BEFORE UPDATE OR DELETE ON release_package_records
FOR EACH ROW EXECUTE FUNCTION prevent_certification_governance_mutation();

CREATE TRIGGER trg_publication_records_immutable
BEFORE UPDATE OR DELETE ON publication_records
FOR EACH ROW EXECUTE FUNCTION prevent_certification_governance_mutation();

CREATE TRIGGER trg_frankai_registration_records_immutable
BEFORE UPDATE OR DELETE ON frankai_registration_records
FOR EACH ROW EXECUTE FUNCTION prevent_certification_governance_mutation();

CREATE OR REPLACE FUNCTION validate_certification_record_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_status agent_version_status;
  readiness_status text;
  readiness_decision certification_readiness_decision;
  plan_outcome evaluation_outcome;
  aps_digest text;
BEGIN
  SELECT av.status,l.certification_status,d.decision,p.aggregate_outcome,aps.sha256
  INTO version_status,readiness_status,readiness_decision,plan_outcome,aps_digest
  FROM agent_versions av
  JOIN lifecycle_readiness l ON l.agent_version_id=av.id
  JOIN certification_readiness_decisions d ON d.agent_version_id=av.id
  JOIN evaluation_plans p ON p.id=NEW.evaluation_plan_id AND p.agent_version_id=av.id
  JOIN aps_specifications aps ON aps.agent_version_id=av.id
  WHERE av.id=NEW.agent_version_id
    AND d.id=NEW.readiness_decision_id;

  IF version_status IS DISTINCT FROM 'EVALUATED' THEN
    RAISE EXCEPTION 'certification requires EVALUATED AgentVersion';
  END IF;
  IF readiness_status IS DISTINCT FROM 'ELIGIBLE' OR readiness_decision IS DISTINCT FROM 'ELIGIBLE' THEN
    RAISE EXCEPTION 'certification requires explicit ELIGIBLE readiness decision';
  END IF;
  IF plan_outcome IS DISTINCT FROM 'PASS' OR NEW.evaluation_aggregate IS DISTINCT FROM 'PASS' THEN
    RAISE EXCEPTION 'certification requires PASS evaluation aggregate';
  END IF;
  IF aps_digest IS DISTINCT FROM NEW.canonical_aps_sha256 THEN
    RAISE EXCEPTION 'certification evidence bundle APS digest mismatch';
  END IF;
  IF NEW.decision='CERTIFY' AND jsonb_array_length(COALESCE(NEW.evidence_bundle->'evidence', '[]'::jsonb))=0 THEN
    RAISE EXCEPTION 'CERTIFY decision requires non-empty evidence bundle';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_certification_record_valid
BEFORE INSERT ON certification_records
FOR EACH ROW EXECUTE FUNCTION validate_certification_record_insert();

CREATE OR REPLACE FUNCTION validate_release_approval_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_status agent_version_status;
  cert_decision certification_decision;
  cert_status text;
BEGIN
  SELECT av.status,c.decision,l.certification_decision_status
  INTO version_status,cert_decision,cert_status
  FROM agent_versions av
  JOIN certification_records c ON c.agent_version_id=av.id
  JOIN lifecycle_readiness l ON l.agent_version_id=av.id
  WHERE av.id=NEW.agent_version_id
    AND c.id=NEW.certification_record_id;

  IF version_status IS DISTINCT FROM 'CERTIFIED'
     OR cert_decision IS DISTINCT FROM 'CERTIFY'
     OR cert_status IS DISTINCT FROM 'CERTIFIED' THEN
    RAISE EXCEPTION 'release approval requires certified AgentVersion and CERTIFY record';
  END IF;

  IF NEW.decision='APPROVE' AND NEW.rights_status NOT IN ('VERIFIED','RESTRICTED') THEN
    RAISE EXCEPTION 'release approval requires distribution-compatible rights status';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_release_approval_valid
BEFORE INSERT ON release_approval_records
FOR EACH ROW EXECUTE FUNCTION validate_release_approval_insert();

CREATE OR REPLACE FUNCTION require_release_approval_for_release_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM release_approval_records r
    WHERE r.agent_version_id=NEW.agent_version_id
      AND r.decision='APPROVE'
  ) INTO approved;

  IF NOT approved THEN
    RAISE EXCEPTION 'release packaging requires explicit release APPROVE decision';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_release_requires_release_approval
BEFORE INSERT ON releases
FOR EACH ROW EXECUTE FUNCTION require_release_approval_for_release_insert();

CREATE OR REPLACE FUNCTION enforce_phase5_agent_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE certified boolean;
BEGIN
  IF NEW.status=OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status='DRAFT'
     AND NEW.status NOT IN ('CANDIDATE','REJECTED','QUARANTINED') THEN
    RAISE EXCEPTION 'DRAFT may only transition to CANDIDATE or an explicit terminal governance state';
  END IF;

  IF OLD.status='CANDIDATE'
     AND NEW.status NOT IN ('VALIDATED','REJECTED','SUPERSEDED','RETIRED','QUARANTINED') THEN
    RAISE EXCEPTION 'CANDIDATE must transition through VALIDATED';
  END IF;

  IF OLD.status='VALIDATED'
     AND NEW.status NOT IN ('EVALUATED','REJECTED','SUPERSEDED','RETIRED','QUARANTINED') THEN
    RAISE EXCEPTION 'VALIDATED must transition through EVALUATED';
  END IF;

  IF OLD.status='EVALUATED'
     AND NEW.status NOT IN ('CERTIFIED','REJECTED','SUPERSEDED','RETIRED','QUARANTINED') THEN
    RAISE EXCEPTION 'EVALUATED may only enter certification or terminal governance states';
  END IF;

  IF OLD.status='EVALUATED' AND NEW.status='CERTIFIED' THEN
    SELECT EXISTS (
      SELECT 1 FROM certification_records c
      WHERE c.agent_version_id=OLD.id
        AND c.decision='CERTIFY'
        AND c.evaluation_aggregate='PASS'
    ) INTO certified;

    IF NOT certified THEN
      RAISE EXCEPTION 'EVALUATED to CERTIFIED requires immutable CERTIFY record';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status='CERTIFIED'
     AND NEW.status NOT IN ('SUPERSEDED','RETIRED','QUARANTINED') THEN
    RAISE EXCEPTION 'CERTIFIED AgentVersion state is stable; packaging/publication use separate records';
  END IF;

  IF OLD.status IN ('REJECTED','SUPERSEDED','RETIRED','QUARANTINED') THEN
    RAISE EXCEPTION 'terminal AgentVersion state cannot transition';
  END IF;

  IF NEW.status='RELEASED' AND OLD.status<>'RELEASED' THEN
    RAISE EXCEPTION 'AgentVersion RELEASED state is not used for packaging/publication; release records are separate';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_phase5_agent_lifecycle
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION enforce_phase5_agent_lifecycle();

COMMIT;
