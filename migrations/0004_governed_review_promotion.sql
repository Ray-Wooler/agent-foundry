BEGIN;

CREATE TYPE semantic_review_decision AS ENUM ('APPROVE','REJECT','REQUEST_CHANGES');

CREATE TABLE semantic_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transformation_id uuid NOT NULL UNIQUE REFERENCES promptforge_transformations(id) ON DELETE RESTRICT,
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  candidate_sha256 text NOT NULL CHECK (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  reviewer_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reviewer_role text NOT NULL CHECK (reviewer_role IN ('OWNER','ADMIN','EDITOR')),
  decision semantic_review_decision NOT NULL,
  rationale text NOT NULL,
  requested_changes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (decision = 'REQUEST_CHANGES' AND requested_changes IS NOT NULL AND length(trim(requested_changes)) > 0)
    OR
    (decision <> 'REQUEST_CHANGES' AND requested_changes IS NULL)
  )
);

CREATE TABLE candidate_revision_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_transformation_id uuid NOT NULL REFERENCES promptforge_transformations(id) ON DELETE RESTRICT,
  child_transformation_id uuid NOT NULL UNIQUE REFERENCES promptforge_transformations(id) ON DELETE RESTRICT,
  parent_agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  child_agent_version_id uuid REFERENCES agent_versions(id) ON DELETE RESTRICT,
  requested_by_review_id uuid NOT NULL UNIQUE REFERENCES semantic_reviews(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_transformation_id <> child_transformation_id)
);

CREATE TABLE lifecycle_readiness (
  agent_version_id uuid PRIMARY KEY REFERENCES agent_versions(id) ON DELETE RESTRICT,
  semantic_approval_status text NOT NULL DEFAULT 'PENDING'
    CHECK (semantic_approval_status IN ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED')),
  evaluation_readiness_status text NOT NULL DEFAULT 'NOT_READY'
    CHECK (evaluation_readiness_status IN ('NOT_READY','READY')),
  certification_status text NOT NULL DEFAULT 'NOT_ELIGIBLE'
    CHECK (certification_status IN ('NOT_ELIGIBLE','ELIGIBLE','CERTIFIED')),
  release_status text NOT NULL DEFAULT 'NOT_ELIGIBLE'
    CHECK (release_status IN ('NOT_ELIGIBLE','ELIGIBLE','RELEASED')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_semantic_review_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'semantic review record is immutable';
END $$;

CREATE TRIGGER trg_semantic_reviews_immutable
BEFORE UPDATE OR DELETE ON semantic_reviews
FOR EACH ROW EXECUTE FUNCTION prevent_semantic_review_mutation();

CREATE OR REPLACE FUNCTION prevent_revision_lineage_mutation()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  IF TG_OP='UPDATE'
     AND OLD.child_agent_version_id IS NULL
     AND NEW.child_agent_version_id IS NOT NULL
     AND NEW.parent_transformation_id=OLD.parent_transformation_id
     AND NEW.child_transformation_id=OLD.child_transformation_id
     AND NEW.parent_agent_version_id=OLD.parent_agent_version_id
     AND NEW.requested_by_review_id=OLD.requested_by_review_id
     AND NEW.created_by_user_id=OLD.created_by_user_id
     AND NEW.created_at=OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'candidate revision lineage is immutable';
END $;

CREATE TRIGGER trg_candidate_revision_lineage_immutable
BEFORE UPDATE OR DELETE ON candidate_revision_lineage
FOR EACH ROW EXECUTE FUNCTION prevent_revision_lineage_mutation();

CREATE OR REPLACE FUNCTION validate_semantic_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status agent_version_status;
  current_sha text;
  transform_status text;
BEGIN
  SELECT av.status, aps.sha256, t.status
  INTO current_status, current_sha, transform_status
  FROM promptforge_transformations t
  JOIN agent_versions av ON av.id=t.agent_version_id
  JOIN aps_specifications aps ON aps.agent_version_id=av.id
  WHERE t.id=NEW.transformation_id
    AND av.id=NEW.agent_version_id;

  IF current_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'semantic review requires DRAFT AgentVersion';
  END IF;

  IF transform_status IS DISTINCT FROM 'REQUIRES_REVIEW' THEN
    RAISE EXCEPTION 'semantic review requires REQUIRES_REVIEW transformation';
  END IF;

  IF current_sha IS DISTINCT FROM NEW.candidate_sha256 THEN
    RAISE EXCEPTION 'semantic review candidate digest does not match canonical APS';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_semantic_review_valid
BEFORE INSERT ON semantic_reviews
FOR EACH ROW EXECUTE FUNCTION validate_semantic_review_insert();

CREATE OR REPLACE FUNCTION require_semantic_approval_for_candidate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approved boolean;
BEGIN
  IF OLD.status='DRAFT' AND NEW.status='CANDIDATE' THEN
    SELECT EXISTS (
      SELECT 1
      FROM semantic_reviews r
      JOIN aps_specifications aps ON aps.agent_version_id=OLD.id
      WHERE r.agent_version_id=OLD.id
        AND r.decision='APPROVE'
        AND r.candidate_sha256=aps.sha256
    ) INTO approved;

    IF NOT approved THEN
      RAISE EXCEPTION 'DRAFT to CANDIDATE promotion requires matching semantic APPROVE review';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_candidate_requires_semantic_approval
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION require_semantic_approval_for_candidate();

CREATE OR REPLACE FUNCTION initialize_lifecycle_readiness()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lifecycle_readiness(agent_version_id) VALUES (NEW.id)
  ON CONFLICT (agent_version_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_lifecycle_readiness_init
AFTER INSERT ON agent_versions
FOR EACH ROW EXECUTE FUNCTION initialize_lifecycle_readiness();

INSERT INTO lifecycle_readiness(agent_version_id)
SELECT id FROM agent_versions
ON CONFLICT (agent_version_id) DO NOTHING;

COMMIT;
