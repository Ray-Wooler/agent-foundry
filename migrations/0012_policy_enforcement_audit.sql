BEGIN;

CREATE UNIQUE INDEX uq_policy_enforcement_evidence
  ON audit_records(target_id)
  WHERE target_type='policy_enforcement_decision';

CREATE OR REPLACE FUNCTION validate_policy_enforcement_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  evaluated_at timestamptz;
  allow_match_count integer;
BEGIN
  IF NEW.target_type <> 'policy_enforcement_decision' THEN
    RETURN NEW;
  END IF;

  IF NEW.actor <> 'policy-enforcement-point' THEN
    RAISE EXCEPTION 'policy enforcement audit actor is fixed';
  END IF;
  IF NEW.action NOT IN ('protected_invocation_allowed','protected_invocation_denied') THEN
    RAISE EXCEPTION 'invalid policy enforcement audit action';
  END IF;
  IF NEW.target_id !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'policy enforcement evidence id must be SHA-256';
  END IF;
  IF NEW.evidence->>'outcome' NOT IN ('ALLOW','DENY') THEN
    RAISE EXCEPTION 'policy enforcement audit outcome required';
  END IF;
  IF (NEW.action='protected_invocation_allowed' AND NEW.evidence->>'outcome'<>'ALLOW')
     OR (NEW.action='protected_invocation_denied' AND NEW.evidence->>'outcome'<>'DENY') THEN
    RAISE EXCEPTION 'policy enforcement action/outcome mismatch';
  END IF;
  IF COALESCE(NEW.evidence->>'tokenSha256','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'policy enforcement token SHA-256 required';
  END IF;
  IF COALESCE(NEW.evidence->>'taskId','')=''
     OR COALESCE(NEW.evidence->>'planId','')=''
     OR COALESCE(NEW.evidence->>'pepVersion','')=''
     OR COALESCE(NEW.evidence->>'reason','')=''
     OR COALESCE(NEW.evidence->>'evaluatedAt','')='' THEN
    RAISE EXCEPTION 'policy enforcement audit evidence incomplete';
  END IF;

  BEGIN
    evaluated_at := (NEW.evidence->>'evaluatedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'policy enforcement evaluatedAt must be a timestamp';
  END;

  IF NEW.action='protected_invocation_allowed' THEN
    IF COALESCE(NEW.evidence->>'decisionId','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'allowed policy enforcement requires authority decision id';
    END IF;

    SELECT count(*)
      INTO allow_match_count
    FROM capability_token_records t
    JOIN authority_decision_records d ON d.decision_id=t.decision_id
    WHERE t.token_sha256=NEW.evidence->>'tokenSha256'
      AND t.decision_id=NEW.evidence->>'decisionId'
      AND d.decision_status='ALLOW'
      AND t.task_id=NEW.evidence->>'taskId'
      AND t.plan_id=NEW.evidence->>'planId'
      AND COALESCE(t.session_id,'')=COALESCE(NEW.evidence->>'sessionId','')
      AND t.issued_at <= evaluated_at
      AND t.expires_at > evaluated_at
      AND (t.revoked_at IS NULL OR t.revoked_at > evaluated_at);

    IF allow_match_count <> 1 THEN
      RAISE EXCEPTION 'allowed policy enforcement is not backed by active persisted authority';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_validate_policy_enforcement_audit
BEFORE INSERT ON audit_records
FOR EACH ROW EXECUTE FUNCTION validate_policy_enforcement_audit();

COMMIT;
