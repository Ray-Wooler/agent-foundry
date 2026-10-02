-- G3 registry integrity acceptance tests.
-- Execute against an isolated PostgreSQL database after 0001_registry.sql.

BEGIN;

INSERT INTO agents(registry_id,slug,name,class) VALUES ('AGR-TEST','test-agent','Test Agent','specialist');
INSERT INTO agent_versions(agent_id,version,status,aps_version)
SELECT id,'0.1.0','DRAFT','1.5-alpha' FROM agents WHERE registry_id='AGR-TEST';

-- Unique version invariant.
DO $$ BEGIN
  BEGIN
    INSERT INTO agent_versions(agent_id,version,status,aps_version)
    SELECT id,'0.1.0','DRAFT','1.5-alpha' FROM agents WHERE registry_id='AGR-TEST';
    RAISE EXCEPTION 'expected unique version violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

INSERT INTO aps_specifications(agent_version_id,document)
SELECT id,'{"aps_version":"1.5-alpha"}'::jsonb FROM agent_versions WHERE version='0.1.0';

-- Promote and freeze.
UPDATE agent_versions SET content_sha256=repeat('a',64), status='CANDIDATE', promoted_at=now() WHERE version='0.1.0';

DO $$ BEGIN
  BEGIN
    UPDATE aps_specifications SET document='{}'::jsonb;
    RAISE EXCEPTION 'expected immutable APS violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected immutable APS violation' THEN RAISE; END IF;
  END;
END $$;

-- Release before certification must fail.
DO $$ BEGIN
  BEGIN
    INSERT INTO releases(agent_version_id,release_version,integrity_sha256)
    SELECT id,'0.1.0',repeat('b',64) FROM agent_versions WHERE version='0.1.0';
    RAISE EXCEPTION 'expected certification gate violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected certification gate violation' THEN RAISE; END IF;
  END;
END $$;

-- Append-only audit.
INSERT INTO audit_records(actor,action,target_type,target_id) VALUES ('test','create','agent','AGR-TEST');
DO $$ BEGIN
  BEGIN
    UPDATE audit_records SET action='tamper';
    RAISE EXCEPTION 'expected append-only violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected append-only violation' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;
