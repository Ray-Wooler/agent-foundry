-- Phase 3 governed review database invariants.
BEGIN;

INSERT INTO app_users(email,display_name,password_hash)
VALUES ('reviewer@example.com','Reviewer','not-used')
RETURNING id;

INSERT INTO workspaces(slug,name) VALUES ('review-test','Review Test') RETURNING id;

INSERT INTO workspace_memberships(workspace_id,user_id,role)
SELECT w.id,u.id,'OWNER'
FROM workspaces w,app_users u
WHERE w.slug='review-test' AND u.email='reviewer@example.com';

INSERT INTO projects(workspace_id,slug,name)
SELECT id,'default','Default' FROM workspaces WHERE slug='review-test';

INSERT INTO agents(registry_id,slug,name,class)
VALUES ('AGR-REVIEW','review-agent','Review Agent','analyst');

INSERT INTO agent_versions(agent_id,version,status,aps_version)
SELECT id,'0.1.0','DRAFT','1.5-alpha' FROM agents WHERE registry_id='AGR-REVIEW';

INSERT INTO aps_specifications(agent_version_id,document,sha256)
SELECT id,'{"aps_version":"1.5-alpha"}'::jsonb,repeat('a',64)
FROM agent_versions WHERE version='0.1.0';

INSERT INTO source_artifacts(
  source_type,title,sha256,rights_status,project_id,created_by_user_id,content_text
)
SELECT 'PROMPT','Review Agent',repeat('b',64),'UNVERIFIED',p.id,u.id,'source'
FROM projects p
JOIN workspaces w ON w.id=p.workspace_id
JOIN app_users u ON u.email='reviewer@example.com'
WHERE w.slug='review-test' AND p.slug='default';

INSERT INTO promptforge_transformations(
  project_id,source_artifact_id,agent_version_id,requested_name,requested_class,status,
  configuration,record,source_sha256,candidate_sha256,created_by_user_id,validation_status
)
SELECT p.id,s.id,av.id,'Review Agent','analyst','REQUIRES_REVIEW',
       '{}'::jsonb,'{}'::jsonb,repeat('b',64),repeat('a',64),u.id,'PASS'
FROM projects p
JOIN workspaces w ON w.id=p.workspace_id
JOIN source_artifacts s ON s.project_id=p.id
JOIN agent_versions av ON av.version='0.1.0'
JOIN app_users u ON u.email='reviewer@example.com'
WHERE w.slug='review-test' AND p.slug='default';

-- Direct promotion without semantic approval must fail.
DO $$ BEGIN
  BEGIN
    UPDATE agent_versions
    SET content_sha256=repeat('a',64),status='CANDIDATE',promoted_at=now()
    WHERE version='0.1.0';
    RAISE EXCEPTION 'expected semantic approval gate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected semantic approval gate' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO semantic_reviews(
  transformation_id,agent_version_id,candidate_sha256,reviewer_user_id,reviewer_role,
  decision,rationale
)
SELECT t.id,av.id,repeat('a',64),u.id,'OWNER','APPROVE','Reviewed and approved'
FROM promptforge_transformations t
JOIN agent_versions av ON av.id=t.agent_version_id
JOIN app_users u ON u.email='reviewer@example.com'
WHERE t.requested_name='Review Agent';

UPDATE lifecycle_readiness
SET semantic_approval_status='APPROVED',evaluation_readiness_status='READY'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

UPDATE agent_versions
SET content_sha256=repeat('a',64),status='CANDIDATE',promoted_at=now()
WHERE version='0.1.0';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_versions WHERE version='0.1.0' AND status='CANDIDATE') THEN
    RAISE EXCEPTION 'approved candidate was not promoted';
  END IF;
END $$;

-- Review records are immutable.
DO $$ BEGIN
  BEGIN
    UPDATE semantic_reviews SET rationale='tampered';
    RAISE EXCEPTION 'expected immutable semantic review';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected immutable semantic review' THEN RAISE; END IF;
  END;
END $$;

-- Semantic approval is distinct from later lifecycle decisions.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM lifecycle_readiness
    WHERE semantic_approval_status='APPROVED'
      AND evaluation_readiness_status='READY'
      AND certification_status='NOT_ELIGIBLE'
      AND release_status='NOT_ELIGIBLE'
  ) THEN
    RAISE EXCEPTION 'lifecycle separation invariant failed';
  END IF;
END $$;

ROLLBACK;
