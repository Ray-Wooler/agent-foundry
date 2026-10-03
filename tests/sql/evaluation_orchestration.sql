-- Phase 4 evaluation orchestration and certification-readiness invariants.
BEGIN;

INSERT INTO app_users(email,display_name,password_hash)
VALUES ('eval-reviewer@example.com','Eval Reviewer','not-used');

INSERT INTO workspaces(slug,name) VALUES ('eval-test','Evaluation Test');

INSERT INTO workspace_memberships(workspace_id,user_id,role)
SELECT w.id,u.id,'OWNER'
FROM workspaces w,app_users u
WHERE w.slug='eval-test' AND u.email='eval-reviewer@example.com';

INSERT INTO projects(workspace_id,slug,name)
SELECT id,'default','Default' FROM workspaces WHERE slug='eval-test';

INSERT INTO agents(registry_id,slug,name,class)
VALUES ('AGR-EVAL','eval-agent','Eval Agent','analyst');

INSERT INTO agent_versions(agent_id,version,status,aps_version)
SELECT id,'0.1.0','DRAFT','1.5-alpha' FROM agents WHERE registry_id='AGR-EVAL';

INSERT INTO aps_specifications(agent_version_id,document,sha256)
SELECT id,
       '{"aps_version":"1.5-alpha","agent":{"id":"eval-agent","name":"Eval Agent","version":"0.1.0","class":"analyst"},"mandate":{"purpose":"test","primary_objective":"test"},"capabilities":[],"governance":{"authority":{"recommendation":[],"execution":[],"delegation":[]}},"operational":{"tools":[]}}'::jsonb,
       repeat('a',64)
FROM agent_versions WHERE version='0.1.0';

INSERT INTO source_artifacts(
  source_type,title,sha256,rights_status,project_id,created_by_user_id,content_text
)
SELECT 'PROMPT','Eval Agent',repeat('b',64),'UNVERIFIED',p.id,u.id,'source'
FROM projects p
JOIN workspaces w ON w.id=p.workspace_id
JOIN app_users u ON u.email='eval-reviewer@example.com'
WHERE w.slug='eval-test' AND p.slug='default';

INSERT INTO promptforge_transformations(
  project_id,source_artifact_id,agent_version_id,requested_name,requested_class,status,
  configuration,record,source_sha256,candidate_sha256,created_by_user_id,validation_status
)
SELECT p.id,s.id,av.id,'Eval Agent','analyst','REQUIRES_REVIEW',
       '{}'::jsonb,'{}'::jsonb,repeat('b',64),repeat('a',64),u.id,'PASS'
FROM projects p
JOIN workspaces w ON w.id=p.workspace_id
JOIN source_artifacts s ON s.project_id=p.id
JOIN agent_versions av ON av.version='0.1.0'
JOIN app_users u ON u.email='eval-reviewer@example.com'
WHERE w.slug='eval-test' AND p.slug='default';

INSERT INTO semantic_reviews(
  transformation_id,agent_version_id,candidate_sha256,reviewer_user_id,reviewer_role,
  decision,rationale
)
SELECT t.id,av.id,repeat('a',64),u.id,'OWNER','APPROVE','semantic approval'
FROM promptforge_transformations t
JOIN agent_versions av ON av.id=t.agent_version_id
JOIN app_users u ON u.email='eval-reviewer@example.com'
WHERE t.requested_name='Eval Agent';

UPDATE lifecycle_readiness
SET semantic_approval_status='APPROVED',evaluation_readiness_status='READY'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

UPDATE agent_versions
SET content_sha256=repeat('a',64),status='CANDIDATE',promoted_at=now()
WHERE version='0.1.0';

-- CANDIDATE cannot skip VALIDATED.
DO $$ BEGIN
  BEGIN
    UPDATE agent_versions SET status='EVALUATED' WHERE version='0.1.0';
    RAISE EXCEPTION 'expected candidate lifecycle sequence violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected candidate lifecycle sequence violation' THEN RAISE; END IF;
  END;
END $$;

-- CANDIDATE cannot become VALIDATED without a READY evaluation plan.
DO $$ BEGIN
  BEGIN
    UPDATE agent_versions SET status='VALIDATED' WHERE version='0.1.0';
    RAISE EXCEPTION 'expected evaluation plan gate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected evaluation plan gate' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO evaluation_plans(agent_version_id,status,created_by_user_id)
SELECT av.id,'PLANNING',u.id
FROM agent_versions av,app_users u
WHERE av.version='0.1.0' AND u.email='eval-reviewer@example.com';

INSERT INTO evaluation_plan_suites(plan_id,evaluation_suite_id,required,ordinal)
SELECT p.id,s.id,true,0
FROM evaluation_plans p,evaluation_suites s
WHERE s.suite_key='core-governance-v1';

INSERT INTO evaluation_suite_executions(plan_id,evaluation_suite_id,status)
SELECT ps.plan_id,ps.evaluation_suite_id,'QUEUED'
FROM evaluation_plan_suites ps;

UPDATE evaluation_plans SET status='READY';

UPDATE lifecycle_readiness
SET evaluation_status='PLANNED'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

UPDATE agent_versions SET status='VALIDATED' WHERE version='0.1.0';

-- VALIDATED cannot become EVALUATED before plan completion.
DO $$ BEGIN
  BEGIN
    UPDATE agent_versions SET status='EVALUATED' WHERE version='0.1.0';
    RAISE EXCEPTION 'expected completed evaluation plan gate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected completed evaluation plan gate' THEN RAISE; END IF;
  END;
END $$;

UPDATE evaluation_suite_executions
SET status='COMPLETED',outcome='PASS',completed_at=now();

UPDATE evaluation_plans
SET status='COMPLETED',aggregate_outcome='PASS',completed_at=now();

UPDATE lifecycle_readiness
SET evaluation_status='PASSED'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

UPDATE agent_versions SET status='EVALUATED' WHERE version='0.1.0';

-- Passing evaluation does not automatically confer certification eligibility.
DO $$ BEGIN
  BEGIN
    UPDATE lifecycle_readiness
    SET certification_status='ELIGIBLE'
    WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');
    RAISE EXCEPTION 'expected explicit certification-readiness decision gate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected explicit certification-readiness decision gate' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO certification_readiness_decisions(
  agent_version_id,evaluation_plan_id,reviewer_user_id,reviewer_role,
  decision,rationale,aggregate_outcome
)
SELECT av.id,p.id,u.id,'OWNER','ELIGIBLE','separate readiness decision','PASS'
FROM agent_versions av,evaluation_plans p,app_users u
WHERE av.version='0.1.0'
  AND p.agent_version_id=av.id
  AND u.email='eval-reviewer@example.com';

UPDATE lifecycle_readiness
SET certification_readiness_status='ELIGIBLE',certification_status='ELIGIBLE'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

-- Phase 4 still cannot certify the AgentVersion.
DO $$ BEGIN
  BEGIN
    UPDATE agent_versions SET status='CERTIFIED' WHERE version='0.1.0';
    RAISE EXCEPTION 'expected separate certification workflow gate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected separate certification workflow gate' THEN RAISE; END IF;
  END;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM agent_versions av
    JOIN lifecycle_readiness l ON l.agent_version_id=av.id
    WHERE av.version='0.1.0'
      AND av.status='EVALUATED'
      AND l.evaluation_status='PASSED'
      AND l.certification_readiness_status='ELIGIBLE'
      AND l.certification_status='ELIGIBLE'
      AND l.release_status='NOT_ELIGIBLE'
  ) THEN
    RAISE EXCEPTION 'Phase 4 lifecycle separation invariant failed';
  END IF;
END $$;

ROLLBACK;
