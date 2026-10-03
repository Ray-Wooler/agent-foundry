BEGIN;

-- Forward-only repair for databases that already recorded 0006 as applied.
-- The original 0006 function remains installed there, so replace only its
-- function body and leave the existing trigger/ledger entry untouched.
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

COMMIT;
