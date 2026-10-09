BEGIN;

CREATE TABLE credential_binding_records (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  binding_id text NOT NULL,
  registry_sha256 text NOT NULL CHECK (registry_sha256 ~ '^[a-f0-9]{64}$'),
  tool_id text NOT NULL,
  operation text NOT NULL,
  operation_binding_id text NOT NULL,
  provider text NOT NULL,
  credential_handle text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,binding_id),
  CHECK (length(trim(binding_id)) > 0),
  CHECK (length(trim(tool_id)) > 0),
  CHECK (length(trim(operation)) > 0),
  CHECK (length(trim(operation_binding_id)) > 0),
  CHECK (length(trim(provider)) > 0),
  CHECK (credential_handle ~ '^[A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9][A-Za-z0-9._/-]*$'),
  CHECK (credential_handle NOT LIKE '%..%')
);

CREATE OR REPLACE FUNCTION prevent_credential_binding_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'credential binding records cannot be deleted';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.registry_sha256 IS DISTINCT FROM OLD.registry_sha256
     OR NEW.tool_id IS DISTINCT FROM OLD.tool_id
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.operation_binding_id IS DISTINCT FROM OLD.operation_binding_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.credential_handle IS DISTINCT FROM OLD.credential_handle
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'credential binding identity is immutable';
  END IF;
  IF OLD.status='DISABLED' AND NEW.status<>'DISABLED' THEN
    RAISE EXCEPTION 'disabled credential binding cannot be reactivated';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_credential_binding_identity_immutable
BEFORE UPDATE OR DELETE ON credential_binding_records
FOR EACH ROW EXECUTE FUNCTION prevent_credential_binding_identity_mutation();

CREATE UNIQUE INDEX uq_credential_broker_evidence
  ON audit_records(target_id)
  WHERE target_type='credential_broker_decision';

CREATE OR REPLACE FUNCTION validate_credential_broker_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  matching_pep integer;
  matching_binding integer;
  matching_token integer;
  workspace_uuid uuid;
  evaluated_at timestamptz;
BEGIN
  IF NEW.target_type <> 'credential_broker_decision' THEN
    RETURN NEW;
  END IF;

  IF NEW.actor <> 'credential-broker' THEN
    RAISE EXCEPTION 'credential broker audit actor is fixed';
  END IF;
  IF NEW.action NOT IN (
    'credential_use_authorized',
    'credential_use_executed',
    'credential_use_denied',
    'credential_use_failed'
  ) THEN
    RAISE EXCEPTION 'invalid credential broker audit action';
  END IF;
  IF NEW.target_id !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'credential broker evidence id must be SHA-256';
  END IF;
  IF COALESCE(NEW.evidence->>'outcome','') NOT IN ('AUTHORIZED','EXECUTED','DENY','FAILED') THEN
    RAISE EXCEPTION 'credential broker outcome required';
  END IF;
  IF (NEW.action='credential_use_authorized' AND NEW.evidence->>'outcome'<>'AUTHORIZED')
     OR (NEW.action='credential_use_executed' AND NEW.evidence->>'outcome'<>'EXECUTED')
     OR (NEW.action='credential_use_denied' AND NEW.evidence->>'outcome'<>'DENY')
     OR (NEW.action='credential_use_failed' AND NEW.evidence->>'outcome'<>'FAILED') THEN
    RAISE EXCEPTION 'credential broker action/outcome mismatch';
  END IF;

  BEGIN
    workspace_uuid := (NEW.evidence->>'workspaceId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'credential broker workspaceId must be UUID';
  END;
  BEGIN
    evaluated_at := (NEW.evidence->>'evaluatedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'credential broker evaluatedAt must be a timestamp';
  END;

  IF COALESCE(NEW.evidence->>'brokerVersion','')=''
     OR COALESCE(NEW.evidence->>'reason','')=''
     OR COALESCE(NEW.evidence->>'enforcementEvidenceId','')=''
     OR COALESCE(NEW.evidence->>'credentialBindingId','')=''
     OR COALESCE(NEW.evidence->>'credentialHandleSha256','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'credential broker audit evidence incomplete';
  END IF;

  IF NEW.evidence ? 'credential'
     OR NEW.evidence ? 'credentialHandle'
     OR NEW.evidence ? 'secret'
     OR NEW.evidence ? 'accessToken'
     OR NEW.evidence ? 'refreshToken' THEN
    RAISE EXCEPTION 'credential broker audit must not persist credential material';
  END IF;

  IF COALESCE(NEW.authority_reference,'') <> COALESCE(NEW.evidence->>'authorityDecisionId','') THEN
    RAISE EXCEPTION 'credential broker authority reference mismatch';
  END IF;
  IF COALESCE(NEW.correlation_id,'') <>
     (NEW.evidence->>'workspaceId') || ':' || (NEW.evidence->>'taskId') || ':' || (NEW.evidence->>'planId') THEN
    RAISE EXCEPTION 'credential broker correlation id mismatch';
  END IF;

  IF NEW.action IN ('credential_use_authorized','credential_use_executed') THEN
    SELECT count(*)
      INTO matching_pep
    FROM audit_records p
    WHERE p.target_type='policy_enforcement_decision'
      AND p.target_id=NEW.evidence->>'enforcementEvidenceId'
      AND p.action='protected_invocation_allowed'
      AND p.authority_reference=NEW.evidence->>'authorityDecisionId'
      AND p.evidence->>'tokenSha256'=NEW.evidence->>'tokenSha256'
      AND p.evidence->>'taskId'=NEW.evidence->>'taskId'
      AND p.evidence->>'planId'=NEW.evidence->>'planId'
      AND COALESCE(p.evidence->>'sessionId','')=COALESCE(NEW.evidence->>'sessionId','')
      AND p.evidence->>'toolId'=NEW.evidence->>'toolId'
      AND p.evidence->>'operation'=NEW.evidence->>'operation'
      AND p.evidence->>'bindingId'=NEW.evidence->>'operationBindingId'
      AND p.evidence->>'registrySha256'=NEW.evidence->>'registrySha256';

    IF matching_pep <> 1 THEN
      RAISE EXCEPTION 'credential use authorization/execution is not backed by allowed policy enforcement';
    END IF;

    SELECT count(*)
      INTO matching_token
    FROM capability_token_records t
    WHERE t.token_sha256=NEW.evidence->>'tokenSha256'
      AND t.decision_id=NEW.evidence->>'authorityDecisionId'
      AND t.task_id=NEW.evidence->>'taskId'
      AND t.plan_id=NEW.evidence->>'planId'
      AND COALESCE(t.session_id,'')=COALESCE(NEW.evidence->>'sessionId','')
      AND t.issued_at <= evaluated_at
      AND t.expires_at > evaluated_at
      AND (t.revoked_at IS NULL OR t.revoked_at > evaluated_at);

    IF matching_token <> 1 THEN
      RAISE EXCEPTION 'credential use authorization/execution is not backed by active durable token state';
    END IF;

    SELECT count(*)
      INTO matching_binding
    FROM credential_binding_records c
    WHERE c.workspace_id=workspace_uuid
      AND c.binding_id=NEW.evidence->>'credentialBindingId'
      AND c.status='ACTIVE'
      AND c.registry_sha256=NEW.evidence->>'registrySha256'
      AND c.tool_id=NEW.evidence->>'toolId'
      AND c.operation=NEW.evidence->>'operation'
      AND c.operation_binding_id=NEW.evidence->>'operationBindingId'
      AND c.provider=NEW.evidence->>'provider'
      AND encode(digest(c.credential_handle,'sha256'),'hex')=NEW.evidence->>'credentialHandleSha256'
      AND position(c.credential_handle in NEW.evidence::text)=0;

    IF matching_binding <> 1 THEN
      RAISE EXCEPTION 'credential use authorization/execution is not backed by active workspace credential binding';
    END IF;
  END IF;

  IF NEW.action='credential_use_executed' THEN
    IF COALESCE(NEW.evidence->>'authorizationEvidenceId','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'executed credential use requires authorization evidence id';
    END IF;

    SELECT count(*)
      INTO matching_pep
    FROM audit_records a
    WHERE a.target_type='credential_broker_decision'
      AND a.target_id=NEW.evidence->>'authorizationEvidenceId'
      AND a.action='credential_use_authorized'
      AND a.authority_reference=NEW.authority_reference
      AND a.evidence->>'workspaceId'=NEW.evidence->>'workspaceId'
      AND a.evidence->>'enforcementEvidenceId'=NEW.evidence->>'enforcementEvidenceId'
      AND a.evidence->>'tokenSha256'=NEW.evidence->>'tokenSha256'
      AND a.evidence->>'taskId'=NEW.evidence->>'taskId'
      AND a.evidence->>'planId'=NEW.evidence->>'planId'
      AND COALESCE(a.evidence->>'sessionId','')=COALESCE(NEW.evidence->>'sessionId','')
      AND a.evidence->>'toolId'=NEW.evidence->>'toolId'
      AND a.evidence->>'operation'=NEW.evidence->>'operation'
      AND a.evidence->>'operationBindingId'=NEW.evidence->>'operationBindingId'
      AND a.evidence->>'credentialBindingId'=NEW.evidence->>'credentialBindingId'
      AND a.evidence->>'registrySha256'=NEW.evidence->>'registrySha256'
      AND a.evidence->>'provider'=NEW.evidence->>'provider'
      AND a.evidence->>'credentialHandleSha256'=NEW.evidence->>'credentialHandleSha256';

    IF matching_pep <> 1 THEN
      RAISE EXCEPTION 'executed credential use is not backed by durable broker authorization';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_validate_credential_broker_audit
BEFORE INSERT ON audit_records
FOR EACH ROW EXECUTE FUNCTION validate_credential_broker_audit();

COMMIT;
