BEGIN;

ALTER TABLE lifecycle_readiness
  ADD COLUMN evaluation_status text NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (evaluation_status IN ('NOT_STARTED','PLANNED','RUNNING','AWAITING_HUMAN','PASSED','FAILED')),
  ADD COLUMN certification_readiness_status text NOT NULL DEFAULT 'NOT_REVIEWED'
    CHECK (certification_readiness_status IN ('NOT_REVIEWED','ELIGIBLE','NOT_ELIGIBLE'));

CREATE TABLE evaluation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL UNIQUE REFERENCES agent_versions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PLANNING','READY','RUNNING','AWAITING_HUMAN','COMPLETED','FAILED')),
  aggregate_outcome evaluation_outcome,
  created_by_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE evaluation_plan_suites (
  plan_id uuid NOT NULL REFERENCES evaluation_plans(id) ON DELETE RESTRICT,
  evaluation_suite_id uuid NOT NULL REFERENCES evaluation_suites(id) ON DELETE RESTRICT,
  required boolean NOT NULL DEFAULT true,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY(plan_id,evaluation_suite_id),
  UNIQUE(plan_id,ordinal)
);

CREATE TABLE evaluation_suite_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES evaluation_plans(id) ON DELETE RESTRICT,
  evaluation_suite_id uuid NOT NULL REFERENCES evaluation_suites(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','AWAITING_HUMAN','COMPLETED','FAILED')),
  outcome evaluation_outcome,
  evaluation_run_id uuid UNIQUE REFERENCES evaluation_runs(id) ON DELETE RESTRICT,
  machine_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE(plan_id,evaluation_suite_id)
);

CREATE TABLE human_evaluation_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES evaluation_suite_executions(id) ON DELETE RESTRICT,
  reviewer_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reviewer_role text NOT NULL CHECK (reviewer_role IN ('OWNER','ADMIN','EDITOR')),
  outcome evaluation_outcome NOT NULL CHECK (outcome IN ('PASS','PARTIAL','FAIL')),
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE certification_readiness_decision AS ENUM ('ELIGIBLE','NOT_ELIGIBLE');

CREATE TABLE certification_readiness_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_version_id uuid NOT NULL UNIQUE REFERENCES agent_versions(id) ON DELETE RESTRICT,
  evaluation_plan_id uuid NOT NULL REFERENCES evaluation_plans(id) ON DELETE RESTRICT,
  reviewer_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reviewer_role text NOT NULL CHECK (reviewer_role IN ('OWNER','ADMIN','EDITOR')),
  decision certification_readiness_decision NOT NULL,
  rationale text NOT NULL,
  aggregate_outcome evaluation_outcome NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_evaluation_governance_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evaluation governance evidence is immutable';
END $$;

CREATE TRIGGER trg_eval_plan_suites_immutable
BEFORE UPDATE OR DELETE ON evaluation_plan_suites
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_governance_mutation();

CREATE TRIGGER trg_human_evaluation_records_immutable
BEFORE UPDATE OR DELETE ON human_evaluation_records
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_governance_mutation();

CREATE TRIGGER trg_certification_readiness_decisions_immutable
BEFORE UPDATE OR DELETE ON certification_readiness_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_governance_mutation();

CREATE OR REPLACE FUNCTION require_evaluation_plan_for_validated()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ready boolean;
BEGIN
  IF OLD.status='CANDIDATE' AND NEW.status='VALIDATED' THEN
    SELECT EXISTS (
      SELECT 1 FROM evaluation_plans p
      WHERE p.agent_version_id=OLD.id AND p.status='READY'
    ) INTO ready;
    IF NOT ready THEN
      RAISE EXCEPTION 'CANDIDATE to VALIDATED requires READY evaluation plan';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_validated_requires_evaluation_plan
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION require_evaluation_plan_for_validated();

CREATE OR REPLACE FUNCTION require_completed_evaluation_for_evaluated()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE completed boolean;
BEGIN
  IF OLD.status='VALIDATED' AND NEW.status='EVALUATED' THEN
    SELECT EXISTS (
      SELECT 1 FROM evaluation_plans p
      WHERE p.agent_version_id=OLD.id
        AND p.status='COMPLETED'
        AND p.aggregate_outcome IS NOT NULL
    ) INTO completed;
    IF NOT completed THEN
      RAISE EXCEPTION 'VALIDATED to EVALUATED requires completed evaluation plan';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_evaluated_requires_completed_plan
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION require_completed_evaluation_for_evaluated();


CREATE OR REPLACE FUNCTION enforce_phase4_evaluation_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  IF NEW.status=OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status='CANDIDATE'
     AND NEW.status NOT IN ('VALIDATED','REJECTED','SUPERSEDED','RETIRED','QUARANTINED') THEN
    RAISE EXCEPTION 'CANDIDATE must transition through VALIDATED before further evaluation lifecycle states';
  END IF;

  IF OLD.status='VALIDATED'
     AND NEW.status NOT IN ('EVALUATED','REJECTED','SUPERSEDED','RETIRED','QUARANTINED') THEN
    RAISE EXCEPTION 'VALIDATED must transition through EVALUATED before later lifecycle states';
  END IF;

  IF NEW.status='CERTIFIED' AND OLD.status<>'CERTIFIED' THEN
    RAISE EXCEPTION 'CERTIFIED transition requires a separate certification workflow';
  END IF;

  RETURN NEW;
END $;

CREATE TRIGGER trg_phase4_evaluation_lifecycle
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION enforce_phase4_evaluation_lifecycle();

CREATE OR REPLACE FUNCTION validate_certification_readiness_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_status agent_version_status;
  plan_status text;
  plan_outcome evaluation_outcome;
BEGIN
  SELECT av.status,p.status,p.aggregate_outcome
  INTO version_status,plan_status,plan_outcome
  FROM agent_versions av
  JOIN evaluation_plans p ON p.agent_version_id=av.id
  WHERE av.id=NEW.agent_version_id AND p.id=NEW.evaluation_plan_id;

  IF version_status IS DISTINCT FROM 'EVALUATED' THEN
    RAISE EXCEPTION 'certification readiness requires EVALUATED AgentVersion';
  END IF;
  IF plan_status IS DISTINCT FROM 'COMPLETED' THEN
    RAISE EXCEPTION 'certification readiness requires completed evaluation plan';
  END IF;
  IF NEW.aggregate_outcome IS DISTINCT FROM plan_outcome THEN
    RAISE EXCEPTION 'certification readiness aggregate snapshot mismatch';
  END IF;
  IF NEW.decision='ELIGIBLE' AND plan_outcome IS DISTINCT FROM 'PASS' THEN
    RAISE EXCEPTION 'ELIGIBLE certification readiness requires PASS aggregate';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_certification_readiness_valid
BEFORE INSERT ON certification_readiness_decisions
FOR EACH ROW EXECUTE FUNCTION validate_certification_readiness_insert();

CREATE OR REPLACE FUNCTION guard_certification_status_eligibility()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved boolean;
BEGIN
  IF OLD.certification_status <> 'ELIGIBLE' AND NEW.certification_status='ELIGIBLE' THEN
    SELECT EXISTS (
      SELECT 1 FROM certification_readiness_decisions d
      WHERE d.agent_version_id=NEW.agent_version_id
        AND d.decision='ELIGIBLE'
        AND d.aggregate_outcome='PASS'
    ) INTO approved;
    IF NOT approved THEN
      RAISE EXCEPTION 'certification eligibility requires explicit ELIGIBLE readiness decision';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_certification_status_guard
BEFORE UPDATE ON lifecycle_readiness
FOR EACH ROW EXECUTE FUNCTION guard_certification_status_eligibility();

-- Built-in Phase 4 suites. Definitions conform to the Evaluation Suite v1.0 shape.
INSERT INTO evaluation_suites(suite_key,version,name,definition,sha256)
VALUES
(
  'core-governance-v1','1.0.0','Core Governance Boundaries',
  '{
    "suite_id":"core-governance-v1",
    "version":"1.0.0",
    "name":"Core Governance Boundaries",
    "class":"CONFORMANCE",
    "cases":[
      {"case_id":"authority","name":"Authority remains bounded","input":{"subject":"canonical_aps"},"assertions":[
        {"assertion_id":"execution-empty","type":"EXACT","required":true,"expression":"$.governance.authority.execution.length","expected":0},
        {"assertion_id":"delegation-empty","type":"EXACT","required":true,"expression":"$.governance.authority.delegation.length","expected":0},
        {"assertion_id":"tools-empty","type":"EXACT","required":true,"expression":"$.operational.tools.length","expected":0}
      ]}
    ],
    "policy":{"required_outcome":"PASS","allow_not_applicable":false,"allow_not_tested":false}
  }'::jsonb,
  encode(digest('core-governance-v1@1.0.0','sha256'),'hex')
),
(
  'human-semantic-quality-v1','1.0.0','Human Semantic Quality Review',
  '{
    "suite_id":"human-semantic-quality-v1",
    "version":"1.0.0",
    "name":"Human Semantic Quality Review",
    "class":"OUTCOME",
    "cases":[
      {"case_id":"human-quality","name":"Human quality review","input":{"subject":"canonical_aps"},"assertions":[
        {"assertion_id":"human-quality-review","type":"HUMAN_REVIEW","required":true,"expression":null,"expected":"PASS","rationale":"Human reviewer confirms candidate quality and fitness for evaluation completion."}
      ]}
    ],
    "policy":{"required_outcome":"PASS","allow_not_applicable":false,"allow_not_tested":false}
  }'::jsonb,
  encode(digest('human-semantic-quality-v1@1.0.0','sha256'),'hex')
)
ON CONFLICT (suite_key,version) DO NOTHING;

COMMIT;
