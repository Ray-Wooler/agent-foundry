BEGIN;

CREATE UNIQUE INDEX uq_policy_enforcement_evidence
  ON audit_records(target_id)
  WHERE target_type='policy_enforcement_decision';

CREATE OR REPLACE FUNCTION validate_policy_enforcement_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR COALESCE(NEW.evidence->>'reason','')='' THEN
    RAISE EXCEPTION 'policy enforcement audit evidence incomplete';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_validate_policy_enforcement_audit
BEFORE INSERT ON audit_records
FOR EACH ROW EXECUTE FUNCTION validate_policy_enforcement_audit();

COMMIT;
