-- Phase 5 certification authority and release approval invariants.
BEGIN;

INSERT INTO app_users(email,display_name,password_hash)
VALUES ('certifier@example.com','Certifier','not-used');

INSERT INTO workspaces(slug,name) VALUES ('cert-test','Certification Test');

INSERT INTO workspace_memberships(workspace_id,user_id,role)
SELECT w.id,u.id,'OWNER'
FROM workspaces w,app_users u
WHERE w.slug='cert-test' AND u.email='certifier@example.com';

INSERT INTO projects(workspace_id,slug,name)
SELECT id,'default','Default' FROM workspaces WHERE slug='cert-test';

INSERT INTO agents(registry_id,slug,name,class)
VALUES ('AGR-CERT','cert-agent','Cert Agent','analyst');

INSERT INTO agent_versions(agent_id,version,status,aps_version)
SELECT id,'0.1.0','DRAFT','1.5-alpha' FROM agents WHERE registry_id='AGR-CERT';

INSERT INTO aps_specifications(agent_version_id,document,sha256)
SELECT id,
       '{"aps_version":"1.5-alpha","agent":{"id":"cert-agent","name":"Cert Agent","version":"0.1.0","class":"analyst"},"mandate":{"purpose":"test","primary_objective":"test"},"capabilities":[],"governance":{"authority":{"recommendation":[],"execution":[],"delegation":[]}},"operational":{"tools":[]}}'::jsonb,
       repeat('a',64)
FROM agent_versions WHERE version='0.1.0';

INSERT INTO source_artifacts(
  source_type,title,sha256,rights_status,project_id,created_by_user_id,content_text
)
SELECT 'PROMPT','Cert Agent',repeat('b',64),'VERIFIED',p.id,u.id,'source'
FROM projects p
JOIN workspaces w ON w.id=p.workspace_id
JOIN app_users u ON u.email='certifier@example.com'
WHERE w.slug='cert-test' AND p.slug='default';

INSERT INTO promptforge_transformations(
  project_id,source_artifact_id,agent_version_id,requested_name,requested_class,status,
  configuration,record,source_sha256,candidate_sha256,created_by_user_id,validation_status
)
SELECT p.id,s.id,av.id,'Cert Agent','analyst','REQUIRES_REVIEW',
       '{}'::jsonb,'{}'::jsonb,repeat('b',64),repeat('a',64),u.id,'PASS'
FROM projects p
JOIN workspaces w ON w.id=p.workspace_id
JOIN source_artifacts s ON s.project_id=p.id
JOIN agent_versions av ON av.version='0.1.0'
JOIN app_users u ON u.email='certifier@example.com'
WHERE w.slug='cert-test' AND p.slug='default';

INSERT INTO semantic_reviews(
  transformation_id,agent_version_id,candidate_sha256,reviewer_user_id,reviewer_role,
  decision,rationale
)
SELECT t.id,av.id,repeat('a',64),u.id,'OWNER','APPROVE','semantic approval'
FROM promptforge_transformations t
JOIN agent_versions av ON av.id=t.agent_version_id
JOIN app_users u ON u.email='certifier@example.com'
WHERE t.requested_name='Cert Agent';

UPDATE lifecycle_readiness
SET semantic_approval_status='APPROVED',evaluation_readiness_status='READY'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

UPDATE agent_versions
SET content_sha256=repeat('a',64),status='CANDIDATE',promoted_at=now()
WHERE version='0.1.0';

INSERT INTO evaluation_plans(agent_version_id,status,aggregate_outcome,created_by_user_id,started_at,completed_at)
SELECT av.id,'COMPLETED','PASS',u.id,now(),now()
FROM agent_versions av,app_users u
WHERE av.version='0.1.0' AND u.email='certifier@example.com';

-- Satisfy Phase 4 transition sequence with a temporary READY state.
UPDATE evaluation_plans SET status='READY',aggregate_outcome=NULL,completed_at=NULL;
UPDATE lifecycle_readiness SET evaluation_status='PLANNED'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');
UPDATE agent_versions SET status='VALIDATED' WHERE version='0.1.0';
UPDATE evaluation_plans SET status='COMPLETED',aggregate_outcome='PASS',completed_at=now();
UPDATE lifecycle_readiness SET evaluation_status='PASSED'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');
UPDATE agent_versions SET status='EVALUATED' WHERE version='0.1.0';

INSERT INTO certification_readiness_decisions(
  agent_version_id,evaluation_plan_id,reviewer_user_id,reviewer_role,
  decision,rationale,aggregate_outcome
)
SELECT av.id,p.id,u.id,'OWNER','ELIGIBLE','ready for certification','PASS'
FROM agent_versions av
JOIN evaluation_plans p ON p.agent_version_id=av.id
JOIN app_users u ON u.email='certifier@example.com'
WHERE av.version='0.1.0';

UPDATE lifecycle_readiness
SET certification_readiness_status='ELIGIBLE',certification_status='ELIGIBLE'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

-- Direct certification without immutable CERTIFY record must fail.
DO $$ BEGIN
  BEGIN
    UPDATE agent_versions SET status='CERTIFIED' WHERE version='0.1.0';
    RAISE EXCEPTION 'expected certification authority gate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected certification authority gate' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO certification_records(
  agent_version_id,evaluation_plan_id,readiness_decision_id,certifier_user_id,certifier_role,
  decision,rationale,evidence_bundle,canonical_aps_sha256,evaluation_aggregate
)
SELECT av.id,p.id,d.id,u.id,'OWNER','CERTIFY','certification authority approved',
       '{"evidence":["evaluation aggregate PASS","readiness ELIGIBLE"]}'::jsonb,
       repeat('a',64),'PASS'
FROM agent_versions av
JOIN evaluation_plans p ON p.agent_version_id=av.id
JOIN certification_readiness_decisions d ON d.agent_version_id=av.id
JOIN app_users u ON u.email='certifier@example.com'
WHERE av.version='0.1.0';

UPDATE lifecycle_readiness
SET certification_decision_status='CERTIFIED',certification_status='CERTIFIED'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

UPDATE agent_versions SET status='CERTIFIED' WHERE version='0.1.0';

-- Certification does not imply release approval or packaging.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM lifecycle_readiness l
    JOIN agent_versions av ON av.id=l.agent_version_id
    WHERE av.version='0.1.0'
      AND av.status='CERTIFIED'
      AND l.release_approval_status='NOT_REVIEWED'
      AND l.packaging_status='NOT_PACKAGED'
      AND l.publication_status='NOT_PUBLISHED'
      AND l.frankai_registration_status='NOT_REGISTERED'
  ) THEN
    RAISE EXCEPTION 'certification separation invariant failed';
  END IF;
END $$;

-- Release package row cannot exist before release approval.
DO $$ BEGIN
  BEGIN
    INSERT INTO releases(agent_version_id,release_version,integrity_sha256)
    SELECT id,'0.1.0',repeat('c',64) FROM agent_versions WHERE version='0.1.0';
    RAISE EXCEPTION 'expected release approval gate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected release approval gate' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO release_approval_records(
  agent_version_id,certification_record_id,approver_user_id,approver_role,
  decision,rationale,intended_distribution,rights_status
)
SELECT av.id,c.id,u.id,'OWNER','APPROVE','approved for controlled packaging',
       'FrankAI internal registry','VERIFIED'
FROM agent_versions av
JOIN certification_records c ON c.agent_version_id=av.id
JOIN app_users u ON u.email='certifier@example.com'
WHERE av.version='0.1.0';

UPDATE lifecycle_readiness
SET release_approval_status='APPROVED',release_status='ELIGIBLE'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

INSERT INTO releases(agent_version_id,release_version,integrity_sha256)
SELECT id,'0.1.0',repeat('c',64) FROM agent_versions WHERE version='0.1.0';

INSERT INTO release_package_records(
  agent_version_id,release_approval_id,release_id,package_sha256,package_location
)
SELECT av.id,ra.id,r.id,repeat('d',64),'fixture://package'
FROM agent_versions av
JOIN release_approval_records ra ON ra.agent_version_id=av.id
JOIN releases r ON r.agent_version_id=av.id
WHERE av.version='0.1.0';

UPDATE lifecycle_readiness
SET packaging_status='PACKAGED'
WHERE agent_version_id=(SELECT id FROM agent_versions WHERE version='0.1.0');

-- Packaging still does not imply publication or FrankAI registration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM publication_records) OR EXISTS (SELECT 1 FROM frankai_registration_records) THEN
    RAISE EXCEPTION 'packaging must not imply publication or registration';
  END IF;
END $$;

-- Governance records are immutable.
DO $$ BEGIN
  BEGIN
    UPDATE certification_records SET rationale='tampered';
    RAISE EXCEPTION 'expected immutable certification record';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected immutable certification record' THEN RAISE; END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE release_approval_records SET rationale='tampered';
    RAISE EXCEPTION 'expected immutable release approval record';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected immutable release approval record' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;
