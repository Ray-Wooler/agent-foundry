import { verifyCapabilityToken, type CapabilityTokenPayload } from "@agent-foundry/authority";
import { canonicalJson, sha256Text } from "@agent-foundry/domain";

export const POLICY_ENFORCEMENT_POINT_VERSION = "pep-core-1.0.0";

export type PersistedCapabilityTokenState = {
  tokenSha256: string;
  tokenId: string;
  decisionId: string;
  taskId: string;
  planId: string;
  sessionId: string | null;
  contractSha256: string;
  roleIds: string[];
  capabilities: string[];
  keyId: string;
  algorithm: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
};

export type InvocationRequest = {
  taskId: string;
  planId: string;
  sessionId: string | null;
  toolId: string;
  operation: string;
};

export type OperationCapabilityBinding = {
  bindingId: string;
  registrySha256: string;
  toolId: string;
  operation: string;
  requiredCapabilities: string[];
};

export type PolicyEnforcementInput = {
  token: string;
  publicKeyPem: string;
  expectedKeyId: string;
  now: string;
  invocation: InvocationRequest;
  binding: OperationCapabilityBinding;
  persistedTokenState: PersistedCapabilityTokenState | null;
};

export type PolicyEnforcementOutcome = "ALLOW" | "DENY";

export type PolicyEnforcementEvidence = {
  pepVersion: string;
  evaluatedAt: string;
  outcome: PolicyEnforcementOutcome;
  reason: string;
  tokenSha256: string;
  tokenId: string | null;
  decisionId: string | null;
  contractSha256: string | null;
  taskId: string;
  planId: string;
  sessionId: string | null;
  toolId: string;
  operation: string;
  bindingId: string;
  registrySha256: string;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  activeCapabilities: string[];
};

export type PolicyEnforcementDecision = {
  outcome: PolicyEnforcementOutcome;
  reason: string;
  evidenceId: string;
  evidence: PolicyEnforcementEvidence;
  tokenPayload: CapabilityTokenPayload | null;
};

function sorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function validNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameTime(a: string, b: string): boolean {
  const aa = Date.parse(a);
  const bb = Date.parse(b);
  return !Number.isNaN(aa) && !Number.isNaN(bb) && aa === bb;
}

function tokenStateMatchesPayload(
  state: PersistedCapabilityTokenState,
  payload: CapabilityTokenPayload,
): boolean {
  return state.tokenId === payload.tokenId
    && state.decisionId === payload.decisionId
    && state.taskId === payload.taskId
    && state.planId === payload.planId
    && state.sessionId === payload.sessionId
    && state.contractSha256 === payload.contractSha256
    && state.keyId === payload.keyId
    && state.algorithm === payload.algorithm
    && JSON.stringify(sorted(state.roleIds)) === JSON.stringify(sorted(payload.roleIds))
    && JSON.stringify(sorted(state.capabilities)) === JSON.stringify(sorted(payload.capabilities))
    && sameTime(state.issuedAt, payload.issuedAt)
    && sameTime(state.expiresAt, payload.expiresAt);
}

function buildDecision(
  input: PolicyEnforcementInput | null | undefined,
  outcome: PolicyEnforcementOutcome,
  reason: string,
  tokenSha256: string,
  payload: CapabilityTokenPayload | null,
): PolicyEnforcementDecision {
  const state = input?.persistedTokenState ?? null;
  const rawNow = input?.now ?? "";
  const parsedNow = Date.parse(rawNow);
  const evaluatedAt = Number.isNaN(parsedNow) ? rawNow : new Date(parsedNow).toISOString();
  const evidence: PolicyEnforcementEvidence = {
    pepVersion: POLICY_ENFORCEMENT_POINT_VERSION,
    evaluatedAt,
    outcome,
    reason,
    tokenSha256,
    tokenId: payload?.tokenId ?? state?.tokenId ?? null,
    decisionId: payload?.decisionId ?? state?.decisionId ?? null,
    contractSha256: payload?.contractSha256 ?? state?.contractSha256 ?? null,
    taskId: input?.invocation?.taskId ?? "",
    planId: input?.invocation?.planId ?? "",
    sessionId: input?.invocation?.sessionId ?? null,
    toolId: input?.invocation?.toolId ?? "",
    operation: input?.invocation?.operation ?? "",
    bindingId: input?.binding?.bindingId ?? "",
    registrySha256: input?.binding?.registrySha256 ?? "",
    requiredCapabilities: input?.binding && Array.isArray(input.binding.requiredCapabilities)
      ? sorted(input.binding.requiredCapabilities)
      : [],
    missingCapabilities: payload && input?.binding && Array.isArray(input.binding.requiredCapabilities)
      ? sorted(input.binding.requiredCapabilities.filter((capability) => !payload.capabilities.includes(capability)))
      : [],
    activeCapabilities: payload ? sorted(payload.capabilities) : [],
  };
  return {
    outcome,
    reason,
    evidenceId: sha256Text(canonicalJson(evidence)),
    evidence,
    tokenPayload: payload,
  };
}

export function enforceInvocation(input: PolicyEnforcementInput): PolicyEnforcementDecision {
  const tokenSha256 = sha256Text(String(input?.token ?? ""));

  if (!input || typeof input !== "object"
    || !validNonEmpty(input.token)
    || !validNonEmpty(input.publicKeyPem)
    || !validNonEmpty(input.expectedKeyId)
    || Number.isNaN(Date.parse(input.now))
    || !input.invocation
    || !validNonEmpty(input.invocation.taskId)
    || !validNonEmpty(input.invocation.planId)
    || !validNonEmpty(input.invocation.toolId)
    || !validNonEmpty(input.invocation.operation)
    || (input.invocation.sessionId !== null && !validNonEmpty(input.invocation.sessionId))
    || !input.binding
    || !validNonEmpty(input.binding.bindingId)
    || !validSha256(input.binding.registrySha256)
    || !validNonEmpty(input.binding.toolId)
    || !validNonEmpty(input.binding.operation)
    || !Array.isArray(input.binding.requiredCapabilities)
    || input.binding.requiredCapabilities.length === 0
    || input.binding.requiredCapabilities.some((capability) => !validNonEmpty(capability))) {
    return buildDecision(input, "DENY", "invalid_enforcement_input", tokenSha256, null);
  }

  if (input.binding.toolId !== input.invocation.toolId
    || input.binding.operation !== input.invocation.operation) {
    return buildDecision(input, "DENY", "operation_binding_mismatch", tokenSha256, null);
  }

  const state = input.persistedTokenState;
  if (!state) {
    return buildDecision(input, "DENY", "token_not_persisted", tokenSha256, null);
  }
  if (!validSha256(state.tokenSha256)
    || !validNonEmpty(state.tokenId)
    || !validSha256(state.decisionId)
    || !validSha256(state.contractSha256)
    || !validNonEmpty(state.keyId)
    || state.algorithm !== "EdDSA"
    || !Array.isArray(state.roleIds) || state.roleIds.length === 0
    || !Array.isArray(state.capabilities) || state.capabilities.length === 0) {
    return buildDecision(input, "DENY", "invalid_persisted_token_state", tokenSha256, null);
  }
  if (state.tokenSha256 !== tokenSha256) {
    return buildDecision(input, "DENY", "persisted_token_hash_mismatch", tokenSha256, null);
  }
  if (state.keyId !== input.expectedKeyId) {
    return buildDecision(input, "DENY", "persisted_key_mismatch", tokenSha256, null);
  }

  let verification;
  try {
    verification = verifyCapabilityToken({
      token: input.token,
      publicKeyPem: input.publicKeyPem,
      expectedKeyId: input.expectedKeyId,
      now: input.now,
      expectedTaskId: input.invocation.taskId,
      expectedPlanId: input.invocation.planId,
      expectedSessionId: input.invocation.sessionId,
      expectedDecisionId: state.decisionId,
      revokedTokenSha256s: state.revokedAt ? [tokenSha256] : [],
    });
  } catch {
    return buildDecision(input, "DENY", "token_verification_error", tokenSha256, null);
  }

  if (!verification.valid) {
    return buildDecision(input, "DENY", `token_${verification.reason}`, tokenSha256, null);
  }

  if (!tokenStateMatchesPayload(state, verification.payload)) {
    return buildDecision(input, "DENY", "persisted_token_state_mismatch", tokenSha256, verification.payload);
  }

  if (state.revokedAt !== null) {
    return buildDecision(input, "DENY", "token_revoked", tokenSha256, verification.payload);
  }

  const requiredCapabilities = sorted(input.binding.requiredCapabilities);
  const missingCapabilities = requiredCapabilities.filter((capability) =>
    !verification.payload.capabilities.includes(capability)
      || !state.capabilities.includes(capability),
  );
  if (missingCapabilities.length) {
    return buildDecision(input, "DENY", "capability_not_authorized", tokenSha256, verification.payload);
  }

  return buildDecision(input, "ALLOW", "authorized_capability_token", tokenSha256, verification.payload);
}
