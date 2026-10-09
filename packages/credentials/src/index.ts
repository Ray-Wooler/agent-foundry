import { canonicalJson, sha256Text } from "@agent-foundry/domain";
import type {
  PersistedCapabilityTokenState,
  PolicyEnforcementDecision,
  PolicyEnforcementEvidence,
} from "@agent-foundry/enforcement";

export const CREDENTIAL_BROKER_VERSION = "credential-broker-core-1.0.0";

export type CredentialBinding = {
  bindingId: string;
  workspaceId: string;
  registrySha256: string;
  toolId: string;
  operation: string;
  operationBindingId: string;
  provider: string;
  credentialHandle: string;
  status: "ACTIVE" | "DISABLED";
};

export type CredentialMaterial = {
  value: string;
  expiresAt?: string | null;
};

export type CredentialSecretResolver = (input: {
  workspaceId: string;
  provider: string;
  credentialHandle: string;
}) => Promise<CredentialMaterial>;

export type CredentialConsumer<T> = (input: {
  credential: string;
  workspaceId: string;
  provider: string;
  toolId: string;
  operation: string;
  taskId: string;
  planId: string;
  sessionId: string | null;
}) => Promise<T>;

export type CredentialBrokerEvidence = {
  brokerVersion: string;
  evaluatedAt: string;
  outcome: "AUTHORIZED" | "EXECUTED" | "DENY" | "FAILED";
  reason: string;
  authorizationEvidenceId: string | null;
  workspaceId: string;
  enforcementEvidenceId: string;
  authorityDecisionId: string;
  tokenSha256: string;
  taskId: string;
  planId: string;
  sessionId: string | null;
  toolId: string;
  operation: string;
  operationBindingId: string;
  credentialBindingId: string;
  registrySha256: string;
  provider: string;
  credentialHandleSha256: string;
};

export type PersistedPolicyEnforcementEvidence = {
  evidenceId: string;
  evidence: PolicyEnforcementEvidence;
};

export type CredentialBrokerAuthorizationDecision = {
  outcome: "AUTHORIZED";
  evidenceId: string;
  evidence: CredentialBrokerEvidence;
};

export type CredentialAuthorizationPersistenceReceipt = {
  evidenceId: string;
  auditRecordId: string;
};

export type CredentialBrokerResult<T> =
  | {
      outcome: "EXECUTED";
      evidenceId: string;
      evidence: CredentialBrokerEvidence;
      result: T;
    }
  | {
      outcome: "DENY" | "FAILED";
      evidenceId: string;
      evidence: CredentialBrokerEvidence;
      result: null;
    };

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeCredentialHandle(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 520
    && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !value.includes("..");
}

function buildEvidence(input: {
  now: string;
  outcome: "AUTHORIZED" | "EXECUTED" | "DENY" | "FAILED";
  reason: string;
  authorizationEvidenceId?: string | null;
  enforcement: PolicyEnforcementDecision | null;
  binding: CredentialBinding | null;
}): CredentialBrokerEvidence {
  const enforcement = input.enforcement;
  const binding = input.binding;
  const ev = enforcement?.evidence;
  const credentialHandle = binding?.credentialHandle ?? "";
  return {
    brokerVersion: CREDENTIAL_BROKER_VERSION,
    evaluatedAt: new Date(Date.parse(input.now)).toISOString(),
    outcome: input.outcome,
    reason: input.reason,
    authorizationEvidenceId: input.authorizationEvidenceId ?? null,
    workspaceId: binding?.workspaceId ?? "UNAVAILABLE",
    enforcementEvidenceId: enforcement?.evidenceId ?? "UNAVAILABLE",
    authorityDecisionId: ev?.decisionId ?? "UNAVAILABLE",
    tokenSha256: ev?.tokenSha256 ?? "UNAVAILABLE",
    taskId: ev?.taskId ?? "UNAVAILABLE",
    planId: ev?.planId ?? "UNAVAILABLE",
    sessionId: ev?.sessionId ?? null,
    toolId: ev?.toolId ?? "UNAVAILABLE",
    operation: ev?.operation ?? "UNAVAILABLE",
    operationBindingId: ev?.bindingId ?? "UNAVAILABLE",
    credentialBindingId: binding?.bindingId ?? "UNAVAILABLE",
    registrySha256: binding?.registrySha256 ?? "UNAVAILABLE",
    provider: binding?.provider ?? "UNAVAILABLE",
    credentialHandleSha256: credentialHandle ? sha256Text(credentialHandle) : "UNAVAILABLE",
  };
}

function finalResult<T>(
  now: string,
  outcome: "DENY" | "FAILED",
  reason: string,
  enforcement: PolicyEnforcementDecision | null,
  binding: CredentialBinding | null,
  authorizationEvidenceId: string | null = null,
): CredentialBrokerResult<T> {
  const evidence = buildEvidence({
    now,
    outcome,
    reason,
    authorizationEvidenceId,
    enforcement,
    binding,
  });
  return {
    outcome,
    evidenceId: sha256Text(canonicalJson(evidence)),
    evidence,
    result: null,
  };
}

function containsCredentialMaterial(
  value: unknown,
  secret: string,
  seen = new WeakSet<object>(),
  depth = 0,
): boolean {
  if (depth > 12) return false;
  if (typeof value === "string") return value.includes(secret);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.some((item) => containsCredentialMaterial(item, secret, seen, depth + 1));
  }
  return Object.values(value as Record<string, unknown>)
    .some((item) => containsCredentialMaterial(item, secret, seen, depth + 1));
}

function validateBinding(binding: CredentialBinding): boolean {
  return Boolean(
    binding
    && nonEmpty(binding.bindingId)
    && validUuid(binding.workspaceId)
    && validSha256(binding.registrySha256)
    && nonEmpty(binding.toolId)
    && nonEmpty(binding.operation)
    && nonEmpty(binding.operationBindingId)
    && nonEmpty(binding.provider)
    && safeCredentialHandle(binding.credentialHandle)
    && ["ACTIVE", "DISABLED"].includes(binding.status),
  );
}

function enforcementAuthorizesBinding(
  enforcement: PolicyEnforcementDecision,
  binding: CredentialBinding,
): boolean {
  const ev = enforcement.evidence;
  const canonicalEvidenceId = ev ? sha256Text(canonicalJson(ev)) : "";
  const payload = enforcement.tokenPayload;
  return enforcement.outcome === "ALLOW"
    && validSha256(enforcement.evidenceId)
    && enforcement.evidenceId === canonicalEvidenceId
    && ev.outcome === "ALLOW"
    && ev.reason === "authorized_capability_token"
    && Array.isArray(ev.missingCapabilities)
    && ev.missingCapabilities.length === 0
    && payload !== null
    && validSha256(ev.decisionId)
    && validSha256(ev.tokenSha256)
    && nonEmpty(ev.taskId)
    && nonEmpty(ev.planId)
    && nonEmpty(ev.toolId)
    && nonEmpty(ev.operation)
    && nonEmpty(ev.bindingId)
    && validSha256(ev.registrySha256)
    && payload.decisionId === ev.decisionId
    && payload.taskId === ev.taskId
    && payload.planId === ev.planId
    && payload.sessionId === ev.sessionId
    && payload.contractSha256 === ev.contractSha256
    && ev.bindingId === binding.operationBindingId
    && ev.toolId === binding.toolId
    && ev.operation === binding.operation
    && ev.registrySha256 === binding.registrySha256;
}

function tokenStateIsCurrent(
  tokenState: PersistedCapabilityTokenState | null,
  enforcement: PolicyEnforcementDecision,
  nowMs: number,
): boolean {
  const payload = enforcement.tokenPayload;
  if (!tokenState || !payload) return false;
  if (!Array.isArray(tokenState.roleIds)
    || !Array.isArray(tokenState.capabilities)
    || tokenState.roleIds.some((x) => !nonEmpty(x))
    || tokenState.capabilities.some((x) => !nonEmpty(x))) return false;

  const issuedAt = Date.parse(tokenState.issuedAt);
  const expiresAt = Date.parse(tokenState.expiresAt);
  return tokenState.tokenSha256 === enforcement.evidence.tokenSha256
    && tokenState.tokenId === payload.tokenId
    && tokenState.decisionId === payload.decisionId
    && tokenState.taskId === payload.taskId
    && tokenState.planId === payload.planId
    && tokenState.sessionId === payload.sessionId
    && tokenState.contractSha256 === payload.contractSha256
    && tokenState.keyId === payload.keyId
    && tokenState.algorithm === payload.algorithm
    && JSON.stringify([...tokenState.roleIds].sort()) === JSON.stringify([...payload.roleIds].sort())
    && JSON.stringify([...tokenState.capabilities].sort()) === JSON.stringify([...payload.capabilities].sort())
    && issuedAt === Date.parse(payload.issuedAt)
    && expiresAt === Date.parse(payload.expiresAt)
    && tokenState.revokedAt === null
    && !Number.isNaN(issuedAt)
    && !Number.isNaN(expiresAt)
    && issuedAt <= nowMs
    && expiresAt > nowMs;
}

export async function executeWithBrokeredCredential<T>(input: {
  workspaceId: string;
  enforcement: PolicyEnforcementDecision;
  persistedEnforcement: PersistedPolicyEnforcementEvidence | null;
  currentTokenState: PersistedCapabilityTokenState | null;
  credentialBinding: CredentialBinding;
  now: string;
  resolveCredential: CredentialSecretResolver;
  consumeCredential: CredentialConsumer<T>;
  persistAuthorization: (
    decision: CredentialBrokerAuthorizationDecision
  ) => Promise<CredentialAuthorizationPersistenceReceipt>;
}): Promise<CredentialBrokerResult<T>> {
  const parsedNow = Date.parse(input?.now ?? "");
  const safeNow = Number.isNaN(parsedNow) ? new Date(0).toISOString() : new Date(parsedNow).toISOString();

  if (!input
    || Number.isNaN(parsedNow)
    || !validUuid(input.workspaceId)
    || typeof input.resolveCredential !== "function"
    || typeof input.consumeCredential !== "function"
    || typeof input.persistAuthorization !== "function") {
    return finalResult<T>(
      safeNow,
      "DENY",
      "invalid_broker_input",
      input?.enforcement ?? null,
      input?.credentialBinding ?? null,
    );
  }

  const persistedEnforcement = input.persistedEnforcement;
  if (!persistedEnforcement
    || !validSha256(persistedEnforcement.evidenceId)
    || persistedEnforcement.evidenceId !== input.enforcement.evidenceId
    || persistedEnforcement.evidenceId !== sha256Text(canonicalJson(persistedEnforcement.evidence))
    || canonicalJson(persistedEnforcement.evidence) !== canonicalJson(input.enforcement.evidence)) {
    return finalResult<T>(
      safeNow,
      "DENY",
      "enforcement_not_durably_anchored",
      input.enforcement,
      input.credentialBinding ?? null,
    );
  }

  if (!tokenStateIsCurrent(input.currentTokenState, input.enforcement, parsedNow)) {
    return finalResult<T>(
      safeNow,
      "DENY",
      "token_state_not_current",
      input.enforcement,
      input.credentialBinding ?? null,
    );
  }

  const binding = input.credentialBinding;
  if (!validateBinding(binding)) {
    return finalResult<T>(safeNow, "DENY", "invalid_credential_binding", input.enforcement, binding ?? null);
  }

  if (binding.workspaceId !== input.workspaceId) {
    return finalResult<T>(safeNow, "DENY", "workspace_binding_mismatch", input.enforcement, binding);
  }

  if (binding.status !== "ACTIVE") {
    return finalResult<T>(safeNow, "DENY", "credential_binding_disabled", input.enforcement, binding);
  }

  if (!enforcementAuthorizesBinding(input.enforcement, binding)) {
    return finalResult<T>(safeNow, "DENY", "enforcement_binding_mismatch", input.enforcement, binding);
  }

  const authorizationEvidence = buildEvidence({
    now: safeNow,
    outcome: "AUTHORIZED",
    reason: "credential_use_authorized",
    authorizationEvidenceId: null,
    enforcement: input.enforcement,
    binding,
  });
  const authorizationDecision: CredentialBrokerAuthorizationDecision = {
    outcome: "AUTHORIZED",
    evidenceId: sha256Text(canonicalJson(authorizationEvidence)),
    evidence: authorizationEvidence,
  };

  let authorizationReceipt: CredentialAuthorizationPersistenceReceipt;
  try {
    authorizationReceipt = await input.persistAuthorization(authorizationDecision);
  } catch {
    return finalResult<T>(
      safeNow,
      "FAILED",
      "authorization_audit_failed",
      input.enforcement,
      binding,
    );
  }

  if (!authorizationReceipt
    || authorizationReceipt.evidenceId !== authorizationDecision.evidenceId
    || !validUuid(authorizationReceipt.auditRecordId)) {
    return finalResult<T>(
      safeNow,
      "FAILED",
      "authorization_audit_receipt_invalid",
      input.enforcement,
      binding,
    );
  }

  const authorizationEvidenceId = authorizationDecision.evidenceId;
  let material: CredentialMaterial;
  try {
    material = await input.resolveCredential({
      workspaceId: input.workspaceId,
      provider: binding.provider,
      credentialHandle: binding.credentialHandle,
    });
  } catch {
    return finalResult<T>(
      safeNow,
      "FAILED",
      "credential_resolution_failed",
      input.enforcement,
      binding,
      authorizationEvidenceId,
    );
  }

  if (!material || !nonEmpty(material.value)) {
    return finalResult<T>(
      safeNow,
      "FAILED",
      "credential_material_invalid",
      input.enforcement,
      binding,
      authorizationEvidenceId,
    );
  }

  if (material.expiresAt !== undefined && material.expiresAt !== null) {
    const expiresAt = Date.parse(material.expiresAt);
    if (Number.isNaN(expiresAt) || expiresAt <= parsedNow) {
      return finalResult<T>(
        safeNow,
        "FAILED",
        "credential_material_expired",
        input.enforcement,
        binding,
        authorizationEvidenceId,
      );
    }
  }

  try {
    const result = await input.consumeCredential({
      credential: material.value,
      workspaceId: input.workspaceId,
      provider: binding.provider,
      toolId: binding.toolId,
      operation: binding.operation,
      taskId: input.enforcement.evidence.taskId,
      planId: input.enforcement.evidence.planId,
      sessionId: input.enforcement.evidence.sessionId,
    });

    if (containsCredentialMaterial(result, material.value)) {
      return finalResult<T>(
        safeNow,
        "FAILED",
        "credential_exposure_blocked",
        input.enforcement,
        binding,
        authorizationEvidenceId,
      );
    }

    const evidence = buildEvidence({
      now: safeNow,
      outcome: "EXECUTED",
      reason: "credential_use_completed",
      authorizationEvidenceId,
      enforcement: input.enforcement,
      binding,
    });
    return {
      outcome: "EXECUTED",
      evidenceId: sha256Text(canonicalJson(evidence)),
      evidence,
      result,
    };
  } catch {
    return finalResult<T>(
      safeNow,
      "FAILED",
      "credential_consumer_failed",
      input.enforcement,
      binding,
      authorizationEvidenceId,
    );
  }
}
