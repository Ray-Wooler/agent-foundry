BEGIN;

ALTER TABLE promptforge_transformations
  ADD COLUMN engine_version text NOT NULL DEFAULT 'promptforge-1.0',
  ADD COLUMN provider text,
  ADD COLUMN model text,
  ADD COLUMN validation_status text CHECK (validation_status IS NULL OR validation_status IN ('PASS','FAIL'));

CREATE TABLE promptforge_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transformation_id uuid NOT NULL REFERENCES promptforge_transformations(id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN (
    'INTENT_ANALYSIS','DEFECT_ANALYSIS','CAPABILITY_EXTRACTION',
    'GOVERNANCE_CONSTRUCTION','REVIEW_EXPLANATION'
  )),
  provider text NOT NULL,
  model text NOT NULL,
  request_id text,
  prompt_sha256 text NOT NULL CHECK (prompt_sha256 ~ '^[a-f0-9]{64}$'),
  response_sha256 text NOT NULL CHECK (response_sha256 ~ '^[a-f0-9]{64}$'),
  output jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promptforge_stage_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transformation_id uuid NOT NULL REFERENCES promptforge_transformations(id) ON DELETE RESTRICT,
  stage text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS','FAIL')),
  output jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transformation_id, stage)
);

CREATE TABLE promptforge_review_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transformation_id uuid NOT NULL UNIQUE REFERENCES promptforge_transformations(id) ON DELETE RESTRICT,
  baseline_candidate jsonb NOT NULL,
  candidate_diff jsonb NOT NULL,
  explanation jsonb NOT NULL,
  validation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_promptforge_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PromptForge evidence is append-only';
END $$;

CREATE TRIGGER trg_promptforge_model_calls_append_only
BEFORE UPDATE OR DELETE ON promptforge_model_calls
FOR EACH ROW EXECUTE FUNCTION prevent_promptforge_evidence_mutation();

CREATE TRIGGER trg_promptforge_stage_results_append_only
BEFORE UPDATE OR DELETE ON promptforge_stage_results
FOR EACH ROW EXECUTE FUNCTION prevent_promptforge_evidence_mutation();

CREATE TRIGGER trg_promptforge_review_packages_append_only
BEFORE UPDATE OR DELETE ON promptforge_review_packages
FOR EACH ROW EXECUTE FUNCTION prevent_promptforge_evidence_mutation();

COMMIT;
