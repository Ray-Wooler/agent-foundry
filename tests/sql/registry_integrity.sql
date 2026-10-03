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

INSERT INTO aps_specifications(agent_version_id,document,sha256)
SELECT id,'{"aps_version":"1.5-alpha"}'::jsonb,repeat('a',64) FROM agent_versions WHERE version='0.1.0';

-- Promotion digest must match canonical APS.
DO $ BEGIN
  BEGIN
    UPDATE agent_versions SET content_sha256=repeat('b',64), status='CANDIDATE', promoted_at=now() WHERE version='0.1.0';
    RAISE EXCEPTION 'expected promotion digest mismatch';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected promotion digest mismatch' THEN RAISE; END IF;
  END;
END $;

-- Promote and freeze with matching digest.
UPDATE agent_versions SET content_sha256=repeat('a',64), status='CANDIDATE', promoted_at=now() WHERE version='0.1.0';

DO $$ BEGIN
  BEGIN
    UPDATE aps_specifications SET document='{}'::jsonb;
    RAISE EXCEPTION 'expected immutable APS violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected immutable APS violation' THEN RAISE; END IF;
  END;
END $$;

-- APS insertion after promotion must fail.
INSERT INTO agent_versions(agent_id,version,status,aps_version,content_sha256,promoted_at)
SELECT id,'0.2.0','CANDIDATE','1.5-alpha',repeat('c',64),now() FROM agents WHERE registry_id='AGR-TEST';

DO $ BEGIN
  BEGIN
    INSERT INTO aps_specifications(agent_version_id,document,sha256)
    SELECT id,'{}'::jsonb,repeat('c',64) FROM agent_versions WHERE version='0.2.0';
    RAISE EXCEPTION 'expected post-promotion APS insert violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected post-promotion APS insert violation' THEN RAISE; END IF;
  END;
END $;

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

-- Release mutation must fail after a valid certified release.
INSERT INTO agent_versions(agent_id,version,status,aps_version,content_sha256,promoted_at)
SELECT id,'1.0.0','CERTIFIED','1.5-alpha',repeat('d',64),now() FROM agents WHERE registry_id='AGR-TEST';
INSERT INTO releases(agent_version_id,release_version,integrity_sha256)
SELECT id,'1.0.0',repeat('e',64) FROM agent_versions WHERE version='1.0.0';

DO $ BEGIN
  BEGIN
    UPDATE releases SET release_version='1.0.1';
    RAISE EXCEPTION 'expected immutable release violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected immutable release violation' THEN RAISE; END IF;
  END;
END $;

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
