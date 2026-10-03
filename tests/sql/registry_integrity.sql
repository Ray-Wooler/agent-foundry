-- G3 registry integrity acceptance tests.
-- Execute against an isolated PostgreSQL database after 0001_registry.sql.

BEGIN;

INSERT INTO agents(registry_id,slug,name,class)
VALUES ('AGR-TEST','test-agent','Test Agent','specialist');

-- AgentVersion must start in DRAFT.
DO $$ BEGIN
  BEGIN
    INSERT INTO agent_versions(agent_id,version,status,aps_version,content_sha256)
    SELECT id,'9.9.9','CERTIFIED','1.5-alpha',repeat('f',64)
    FROM agents WHERE registry_id='AGR-TEST';
    RAISE EXCEPTION 'expected initial DRAFT violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected initial DRAFT violation' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO agent_versions(agent_id,version,status,aps_version)
SELECT id,'0.1.0','DRAFT','1.5-alpha'
FROM agents WHERE registry_id='AGR-TEST';

-- Unique version invariant.
DO $$ BEGIN
  BEGIN
    INSERT INTO agent_versions(agent_id,version,status,aps_version)
    SELECT id,'0.1.0','DRAFT','1.5-alpha'
    FROM agents WHERE registry_id='AGR-TEST';
    RAISE EXCEPTION 'expected unique version violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

INSERT INTO aps_specifications(agent_version_id,document,sha256)
SELECT id,'{"aps_version":"1.5-alpha"}'::jsonb,repeat('a',64)
FROM agent_versions WHERE version='0.1.0';

-- Promotion digest must match canonical APS.
DO $$ BEGIN
  BEGIN
    UPDATE agent_versions
    SET content_sha256=repeat('b',64), status='CANDIDATE', promoted_at=now()
    WHERE version='0.1.0';
    RAISE EXCEPTION 'expected promotion digest mismatch';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected promotion digest mismatch' THEN RAISE; END IF;
  END;
END $$;

-- Promote and freeze with matching digest.
UPDATE agent_versions
SET content_sha256=repeat('a',64), status='CANDIDATE', promoted_at=now()
WHERE version='0.1.0';

-- Canonical APS cannot change after promotion.
DO $$ BEGIN
  BEGIN
    UPDATE aps_specifications SET document='{}'::jsonb;
    RAISE EXCEPTION 'expected immutable APS violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected immutable APS violation' THEN RAISE; END IF;
  END;
END $$;

-- A promoted version cannot acquire a second/replacement APS row.
DO $$ BEGIN
  BEGIN
    INSERT INTO aps_specifications(agent_version_id,document,sha256)
    SELECT id,'{}'::jsonb,repeat('a',64)
    FROM agent_versions WHERE version='0.1.0';
    RAISE EXCEPTION 'expected post-promotion APS insert violation';
  EXCEPTION
    WHEN unique_violation THEN NULL;
    WHEN raise_exception THEN
      IF SQLERRM = 'expected post-promotion APS insert violation' THEN RAISE; END IF;
  END;
END $$;

-- Release before certification must fail.
DO $$ BEGIN
  BEGIN
    INSERT INTO releases(agent_version_id,release_version,integrity_sha256)
    SELECT id,'0.1.0',repeat('b',64)
    FROM agent_versions WHERE version='0.1.0';
    RAISE EXCEPTION 'expected certification gate violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected certification gate violation' THEN RAISE; END IF;
  END;
END $$;

-- Build a valid certified version through the lifecycle.
INSERT INTO agent_versions(agent_id,version,status,aps_version)
SELECT id,'1.0.0','DRAFT','1.5-alpha'
FROM agents WHERE registry_id='AGR-TEST';

INSERT INTO aps_specifications(agent_version_id,document,sha256)
SELECT id,'{"aps_version":"1.5-alpha"}'::jsonb,repeat('d',64)
FROM agent_versions WHERE version='1.0.0';

UPDATE agent_versions
SET content_sha256=repeat('d',64), status='CERTIFIED', promoted_at=now()
WHERE version='1.0.0';

INSERT INTO releases(agent_version_id,release_version,integrity_sha256)
SELECT id,'1.0.0',repeat('e',64)
FROM agent_versions WHERE version='1.0.0';

-- Release rows are immutable; they cannot be retargeted or edited.
DO $$ BEGIN
  BEGIN
    UPDATE releases SET release_version='1.0.1';
    RAISE EXCEPTION 'expected immutable release violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected immutable release violation' THEN RAISE; END IF;
  END;
END $$;

-- Append-only audit.
INSERT INTO audit_records(actor,action,target_type,target_id)
VALUES ('test','create','agent','AGR-TEST');

DO $$ BEGIN
  BEGIN
    UPDATE audit_records SET action='tamper';
    RAISE EXCEPTION 'expected append-only violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected append-only violation' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;
