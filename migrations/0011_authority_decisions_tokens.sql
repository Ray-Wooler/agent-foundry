BEGIN;

CREATE TABLE authority_decision_records (
  decision_id text PRIMARY KEY CHECK (decision_id ~ '^[a-f0-9]{64}$'),
  resolver_version text NOT NULL,
  decision_status text NOT NULL CHECK (decision_status IN ('ALLOW','REQUIRES_APPROVAL','DENY')),
  task_id text NOT NULL,
  plan_id text NOT NULL,
  session_id text,
  contract_sha256 text NOT NULL CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (evidence ? 'decisionStatus' AND evidence->>'decisionStatus' = decision_status),
  CHECK (evidence ? 'resolverVersion' AND evidence->>'resolverVersion' = resolver_version),
  CHECK (evidence ? 'taskId' AND evidence->>'taskId' = task_id),
  CHECK (evidence ? 'planId' AND evidence->>'planId' = plan_id),
  CHECK (evidence ? 'sessionId' AND COALESCE(evidence->>'sessionId','') = COALESCE(session_id,'')),
  CHECK (evidence ? 'contractSha256' AND evidence->>'contractSha256' = contract_sha256),
  CHECK (evidence ? 'evaluatedAt' AND (evidence->>'evaluatedAt')::timestamptz IS NOT NULL)
);

CREATE TABLE capability_token_records (
  token_id uuid PRIMARY KEY,
  decision_id text NOT NULL REFERENCES authority_decision_records(decision_id) ON DELETE RESTRICT,
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  token_version text NOT NULL CHECK (token_version='1.0'),
  issuer text NOT NULL CHECK (issuer='agent-foundry'),
  algorithm text NOT NULL CHECK (algorithm='EdDSA'),
  key_id text NOT NULL,
  task_id text NOT NULL,
  plan_id text NOT NULL,
  session_id text,
  contract_sha256 text NOT NULL CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  role_ids jsonb NOT NULL,
  capabilities jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '900 seconds'),
  CHECK ((revoked_at IS NULL AND revocation_reason IS NULL)
      OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

CREATE INDEX idx_capability_token_records_active
  ON capability_token_records(expires_at)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION prevent_authority_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authority decision records are immutable';
END $$;

CREATE TRIGGER trg_authority_decision_immutable
BEFORE UPDATE OR DELETE ON authority_decision_records
FOR EACH ROW EXECUTE FUNCTION prevent_authority_decision_mutation();

CREATE OR REPLACE FUNCTION enforce_capability_token_allow_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decision authority_decision_records%ROWTYPE;
  supporting_expiry timestamptz;
BEGIN
  SELECT * INTO decision
  FROM authority_decision_records
  WHERE decision_id=NEW.decision_id;

  IF NOT FOUND OR decision.decision_status <> 'ALLOW' THEN
    RAISE EXCEPTION 'capability token requires persisted ALLOW decision';
  END IF;
  IF NEW.task_id IS DISTINCT FROM decision.task_id
     OR NEW.plan_id IS DISTINCT FROM decision.plan_id
     OR NEW.session_id IS DISTINCT FROM decision.session_id
     OR NEW.contract_sha256 IS DISTINCT FROM decision.contract_sha256 THEN
    RAISE EXCEPTION 'capability token context must match authority decision';
  END IF;
  IF NEW.role_ids IS DISTINCT FROM decision.evidence->'selectedRoleIds'
     OR NEW.capabilities IS DISTINCT FROM decision.evidence->'selectedCapabilities' THEN
    RAISE EXCEPTION 'capability token authority must match authority decision';
  END IF;

  SELECT min((item->>'expiresAt')::timestamptz)
    INTO supporting_expiry
  FROM jsonb_array_elements(
    COALESCE(decision.evidence->'supportingAuthorizationExpiries','[]'::jsonb)
  ) AS item;

  IF supporting_expiry IS NULL OR NEW.expires_at > supporting_expiry THEN
    RAISE EXCEPTION 'capability token expiry exceeds supporting authorization';
  END IF;
  IF NEW.issued_at < (decision.evidence->>'evaluatedAt')::timestamptz
     OR NEW.issued_at > (decision.evidence->>'evaluatedAt')::timestamptz + interval '300 seconds' THEN
    RAISE EXCEPTION 'capability token issuance is outside authority decision freshness window';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_capability_token_allow_decision
BEFORE INSERT ON capability_token_records
FOR EACH ROW EXECUTE FUNCTION enforce_capability_token_allow_decision();

CREATE OR REPLACE FUNCTION prevent_capability_token_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'capability token records cannot be deleted';
  END IF;
  IF NEW.token_id IS DISTINCT FROM OLD.token_id
     OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
     OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256
     OR NEW.token_version IS DISTINCT FROM OLD.token_version
     OR NEW.issuer IS DISTINCT FROM OLD.issuer
     OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
     OR NEW.key_id IS DISTINCT FROM OLD.key_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.contract_sha256 IS DISTINCT FROM OLD.contract_sha256
     OR NEW.role_ids IS DISTINCT FROM OLD.role_ids
     OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'capability token identity is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason) THEN
    RAISE EXCEPTION 'capability token revocation is immutable';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NULL THEN
    RAISE EXCEPTION 'capability token revocation requires reason';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_capability_token_identity_immutable
BEFORE UPDATE OR DELETE ON capability_token_records
FOR EACH ROW EXECUTE FUNCTION prevent_capability_token_identity_mutation();

COMMIT;
