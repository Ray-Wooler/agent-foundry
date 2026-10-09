import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { canonicalJson, sha256Text } from "@agent-foundry/domain";

export const AUTHORITY_RESOLVER_VERSION = "authority-resolver-core-1.0.0";

export type AuthorizationMode = "ALLOW_TASK" | "ALLOW_SESSION" | "AUTHORIZE_ROLE" | "DENY";

export type ContextualAuthorityRole = {
  id: string;
  capabilities: string[];
  inherits?: string[];
};

export type ContextualAuthorityContract = {
  contract_version: "1.0";
  authority_model: "contextual_least_privilege";
  roles: ContextualAuthorityRole[];
  activation: {
    default: "INACTIVE";
    scope: "TASK" | "SESSION";
    expiry_required: true;
  };
  authorization_modes: AuthorizationMode[];
  task_token: {
    task_bound: true;
    plan_bound: true;
    expiry_required: true;
  };
  runtime_enforcement: {
    required: true;
    fail_mode: "DENY";
    credential_isolation_required: true;
  };
  replanning: {
    authority_expansion_requires_reauthorization: true;
    post_untrusted_context_expansion_requires_human_approval: true;
  };
  delegation: {
    child_authority_must_be_subset: true;
  };
  audit: {
    record_plan: true;
    record_requested_roles: true;
    record_approved_roles: true;
    record_active_roles: true;
    record_tool_invocations: true;
    record_denials: true;
  };
  resource_constraints?: string[];
  argument_constraints?: string[];
  budgets?: string[];
};

export type ExecutionPlanAuthorityRequest = {
  taskId: string;
  planId: string;
  requiredCapabilities: string[];
  consumedUntrustedContext: boolean;
};

export type ReusableAuthorization = {
  authorizationId: string;
  roleId: string;
  mode: AuthorizationMode;
  taskId?: string;
  sessionId?: string;
  expiresAt: string;
};

export type AuthorityResolutionInput = {
  contract: ContextualAuthorityContract;
  plan: ExecutionPlanAuthorityRequest;
  authorizations: ReusableAuthorization[];
  now: string;
  sessionId?: string;
  previousActiveRoleIds?: string[];
  delegationCeilingCapabilities?: string[];
};

export type AuthorityResolutionStatus = "ALLOW" | "REQUIRES_APPROVAL" | "DENY";

export type AuthorityDecisionEvidence = {
  decisionStatus: AuthorityResolutionStatus;
  resolverVersion: string;
  contractSha256: string;
  evaluatedAt: string;
  taskId: string;
  planId: string;
  sessionId: string | null;
  requiredCapabilities: string[];
  selectedRoleIds: string[];
  selectedCapabilities: string[];
  previousActiveCapabilities: string[];
  missingCapabilities: string[];
  unauthorizedRoleIds: string[];
  deniedRoleIds: string[];
  supportingAuthorizationIds: string[];
  supportingAuthorizationExpiries: Array<{ authorizationId: string; expiresAt: string }>;
  denialAuthorizationIds: string[];
  expiredAuthorizationIds: string[];
  delegationCeilingCapabilities: string[] | null;
  delegationExceededCapabilities: string[];
  consumedUntrustedContext: boolean;
  authorityExpansion: boolean;
  reasons: string[];
};

export type AuthorityResolution = {
  status: AuthorityResolutionStatus;
  selectedRoleIds: string[];
  selectedCapabilities: string[];
  requiredApprovalRoleIds: string[];
  decisionId: string;
  evidence: AuthorityDecisionEvidence;
};

type RoleClosure = {
  roleId: string;
  capabilities: Set<string>;
};

const MAX_ROLE_CANDIDATES = 20;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid authority resolver input: ${field}`);
  }
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`invalid authority resolver input: ${field}`);
  return parsed;
}

function validateInput(input: AuthorityResolutionInput): void {
  if (!input || typeof input !== "object" || !input.plan || typeof input.plan !== "object") {
    throw new Error("invalid authority resolver input: request");
  }
  assertNonEmpty(input.plan.taskId, "plan.taskId");
  assertNonEmpty(input.plan.planId, "plan.planId");
  if (!Array.isArray(input.plan.requiredCapabilities)
    || input.plan.requiredCapabilities.some((capability) => typeof capability !== "string" || capability.length === 0)) {
    throw new Error("invalid authority resolver input: plan.requiredCapabilities");
  }
  if (typeof input.plan.consumedUntrustedContext !== "boolean") {
    throw new Error("invalid authority resolver input: plan.consumedUntrustedContext");
  }
  if (!Array.isArray(input.authorizations)) {
    throw new Error("invalid authority resolver input: authorizations");
  }
  if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || input.sessionId.length === 0)) {
    throw new Error("invalid authority resolver input: sessionId");
  }
  if (input.previousActiveRoleIds !== undefined
    && (!Array.isArray(input.previousActiveRoleIds)
      || input.previousActiveRoleIds.some((roleId) => typeof roleId !== "string" || roleId.length === 0))) {
    throw new Error("invalid authority resolver input: previousActiveRoleIds");
  }
  if (input.delegationCeilingCapabilities !== undefined
    && (!Array.isArray(input.delegationCeilingCapabilities)
      || input.delegationCeilingCapabilities.some((capability) => typeof capability !== "string" || capability.length === 0))) {
    throw new Error("invalid authority resolver input: delegationCeilingCapabilities");
  }
  parseTimestamp(input.now, "now");

  const contract = input.contract;
  if (!contract || contract.contract_version !== "1.0" || contract.authority_model !== "contextual_least_privilege") {
    throw new Error("invalid authority resolver input: unsupported contextual authority contract");
  }
  if (!Array.isArray(contract.roles) || contract.roles.length === 0) {
    throw new Error("invalid authority resolver input: contextual authority roles required");
  }
  if (contract.activation?.default !== "INACTIVE" || contract.activation?.expiry_required !== true) {
    throw new Error("invalid authority resolver input: activation contract must be inactive by default and expiring");
  }
  if (!["TASK", "SESSION"].includes(contract.activation?.scope)) {
    throw new Error("invalid authority resolver input: activation scope");
  }
  const contractModes = Array.isArray(contract.authorization_modes)
    ? uniqueSorted(contract.authorization_modes)
    : [];
  if (JSON.stringify(contractModes) !== JSON.stringify(["ALLOW_SESSION", "ALLOW_TASK", "AUTHORIZE_ROLE", "DENY"])) {
    throw new Error("invalid authority resolver input: authorization modes");
  }
  if (contract.task_token?.task_bound !== true
    || contract.task_token?.plan_bound !== true
    || contract.task_token?.expiry_required !== true) {
    throw new Error("invalid authority resolver input: task token contract");
  }
  if (contract.runtime_enforcement?.required !== true
    || contract.runtime_enforcement?.fail_mode !== "DENY"
    || contract.runtime_enforcement?.credential_isolation_required !== true) {
    throw new Error("invalid authority resolver input: runtime enforcement contract");
  }
  if (contract.replanning?.authority_expansion_requires_reauthorization !== true
    || contract.replanning?.post_untrusted_context_expansion_requires_human_approval !== true) {
    throw new Error("invalid authority resolver input: replanning contract");
  }
  if (contract.delegation?.child_authority_must_be_subset !== true) {
    throw new Error("invalid authority resolver input: delegation contract");
  }

  const roleIds = contract.roles.map((role) => role?.id);
  if (roleIds.some((id) => typeof id !== "string" || id.length === 0) || new Set(roleIds).size !== roleIds.length) {
    throw new Error("invalid authority resolver input: role ids");
  }
  const known = new Set(roleIds);
  for (const role of contract.roles) {
    if (!Array.isArray(role.capabilities) || role.capabilities.length === 0
      || role.capabilities.some((capability) => typeof capability !== "string" || capability.length === 0)) {
      throw new Error(`invalid authority resolver input: role ${role.id} capabilities`);
    }
    if (role.inherits !== undefined && !Array.isArray(role.inherits)) {
      throw new Error(`invalid authority resolver input: role ${role.id} inheritance`);
    }
    if ((role.inherits ?? []).some((parent) => typeof parent !== "string" || !known.has(parent))) {
      throw new Error(`invalid authority resolver input: role ${role.id} inherits unknown role`);
    }
  }

  const modes = new Set<AuthorizationMode>(["ALLOW_TASK", "ALLOW_SESSION", "AUTHORIZE_ROLE", "DENY"]);
  const authorizationIds = input.authorizations.map((authorization) => authorization?.authorizationId);
  if (authorizationIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(authorizationIds).size !== authorizationIds.length) {
    throw new Error("invalid authority resolver input: authorization ids must be unique and non-empty");
  }
  for (const authorization of input.authorizations) {
    if (!authorization || typeof authorization !== "object") {
      throw new Error("invalid authority resolver input: authorization record");
    }
    assertNonEmpty(authorization.authorizationId, "authorization.authorizationId");
    assertNonEmpty(authorization.roleId, "authorization.roleId");
    if (!known.has(authorization.roleId)) {
      throw new Error(`invalid authority resolver input: authorization references unknown role ${authorization.roleId}`);
    }
    if (!modes.has(authorization.mode)) {
      throw new Error(`invalid authority resolver input: authorization ${authorization.authorizationId}.mode`);
    }
    parseTimestamp(authorization.expiresAt, `authorization ${authorization.authorizationId}.expiresAt`);
    if (authorization.mode === "ALLOW_TASK"
      && (typeof authorization.taskId !== "string" || authorization.taskId.length === 0)) {
      throw new Error(`invalid authority resolver input: authorization ${authorization.authorizationId}.taskId`);
    }
    if (authorization.mode === "ALLOW_SESSION"
      && (typeof authorization.sessionId !== "string" || authorization.sessionId.length === 0)) {
      throw new Error(`invalid authority resolver input: authorization ${authorization.authorizationId}.sessionId`);
    }
    if (authorization.taskId !== undefined && (typeof authorization.taskId !== "string" || authorization.taskId.length === 0)) {
      throw new Error(`invalid authority resolver input: authorization ${authorization.authorizationId}.taskId`);
    }
    if (authorization.sessionId !== undefined && (typeof authorization.sessionId !== "string" || authorization.sessionId.length === 0)) {
      throw new Error(`invalid authority resolver input: authorization ${authorization.authorizationId}.sessionId`);
    }
  }
}

function buildRoleClosures(roles: ContextualAuthorityRole[]): RoleClosure[] {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const visiting = new Set<string>();
  const memo = new Map<string, Set<string>>();

  const visit = (roleId: string): Set<string> => {
    const existing = memo.get(roleId);
    if (existing) return existing;
    if (visiting.has(roleId)) throw new Error("invalid authority resolver input: cyclic role hierarchy");
    const role = byId.get(roleId);
    if (!role) throw new Error(`invalid authority resolver input: unknown role ${roleId}`);
    visiting.add(roleId);
    const capabilities = new Set(role.capabilities);
    for (const parent of role.inherits ?? []) {
      for (const capability of visit(parent)) capabilities.add(capability);
    }
    visiting.delete(roleId);
    memo.set(roleId, capabilities);
    return capabilities;
  };

  return [...byId.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((roleId) => ({ roleId, capabilities: visit(roleId) }));
}

function unionCapabilities(roleIds: string[], closures: Map<string, Set<string>>): Set<string> {
  const result = new Set<string>();
  for (const roleId of roleIds) {
    for (const capability of closures.get(roleId) ?? []) result.add(capability);
  }
  return result;
}

function coversRequired(selected: RoleClosure[], required: Set<string>): boolean {
  const covered = new Set<string>();
  for (const role of selected) for (const capability of role.capabilities) covered.add(capability);
  for (const capability of required) if (!covered.has(capability)) return false;
  return true;
}

function compareSelections(a: RoleClosure[], b: RoleClosure[], required: Set<string>): number {
  const extras = (selection: RoleClosure[]) => {
    const union = new Set<string>();
    for (const role of selection) for (const capability of role.capabilities) union.add(capability);
    let extra = 0;
    for (const capability of union) if (!required.has(capability)) extra++;
    return extra;
  };
  const extraDiff = extras(a) - extras(b);
  if (extraDiff !== 0) return extraDiff;
  if (a.length !== b.length) return a.length - b.length;
  return a.map((role) => role.roleId).sort().join("\u0000")
    .localeCompare(b.map((role) => role.roleId).sort().join("\u0000"));
}

function chooseLeastPrivilegeRoles(closures: RoleClosure[], requiredCapabilities: string[]): RoleClosure[] | null {
  const required = new Set(requiredCapabilities);
  if (required.size === 0) return [];
  const candidates = closures.filter((role) =>
    [...role.capabilities].some((capability) => required.has(capability)),
  );
  if (candidates.length > MAX_ROLE_CANDIDATES) {
    throw new Error(`authority resolver complexity bound exceeded: ${candidates.length} candidate roles`);
  }

  let best: RoleClosure[] | null = null;
  const search = (index: number, selected: RoleClosure[]) => {
    if (coversRequired(selected, required)) {
      if (!best || compareSelections(selected, best, required) < 0) best = [...selected];
      return;
    }
    if (index >= candidates.length) return;

    selected.push(candidates[index]!);
    search(index + 1, selected);
    selected.pop();
    search(index + 1, selected);
  };

  search(0, []);
  return best;
}

function authorizationApplies(
  authorization: ReusableAuthorization,
  input: AuthorityResolutionInput,
  nowMs: number,
): { applies: boolean; expired: boolean } {
  const expiresAt = parseTimestamp(authorization.expiresAt, `authorization ${authorization.authorizationId}.expiresAt`);
  if (expiresAt <= nowMs) return { applies: false, expired: true };
  if (authorization.mode === "ALLOW_TASK") {
    return { applies: authorization.taskId === input.plan.taskId, expired: false };
  }
  if (authorization.mode === "ALLOW_SESSION") {
    return { applies: Boolean(input.sessionId) && authorization.sessionId === input.sessionId, expired: false };
  }
  if (authorization.mode === "DENY") {
    const taskApplies = !authorization.taskId || authorization.taskId === input.plan.taskId;
    const sessionApplies = !authorization.sessionId || authorization.sessionId === input.sessionId;
    return { applies: taskApplies && sessionApplies, expired: false };
  }
  return { applies: true, expired: false };
}

function setIsSubset(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) if (!superset.has(value)) return false;
  return true;
}

export function resolveAuthority(input: AuthorityResolutionInput): AuthorityResolution {
  validateInput(input);
  const nowMs = parseTimestamp(input.now, "now");
  const requiredCapabilities = uniqueSorted(input.plan.requiredCapabilities);
  const closures = buildRoleClosures(input.contract.roles);
  const closureMap = new Map(closures.map((entry) => [entry.roleId, entry.capabilities]));

  const allCapabilities = new Set<string>();
  for (const role of closures) for (const capability of role.capabilities) allCapabilities.add(capability);
  const missingCapabilities = requiredCapabilities.filter((capability) => !allCapabilities.has(capability));

  const selected = missingCapabilities.length ? null : chooseLeastPrivilegeRoles(closures, requiredCapabilities);
  const selectedRoleIds = selected ? selected.map((role) => role.roleId).sort() : [];
  const selectedCapabilities = uniqueSorted(
    selected ? [...unionCapabilities(selectedRoleIds, closureMap)] : [],
  );

  const previousActiveRoleIds = uniqueSorted(input.previousActiveRoleIds ?? []);
  const unknownPreviousRoleIds = previousActiveRoleIds.filter((roleId) => !closureMap.has(roleId));
  if (unknownPreviousRoleIds.length) {
    throw new Error(`invalid authority resolver input: unknown previous active roles ${unknownPreviousRoleIds.join(",")}`);
  }
  const previousActiveCapabilities = uniqueSorted([...unionCapabilities(previousActiveRoleIds, closureMap)]);
  const previousSet = new Set(previousActiveCapabilities);
  const expansionCapabilities = selectedCapabilities.filter((capability) => !previousSet.has(capability));
  const authorityExpansion = expansionCapabilities.length > 0;

  const delegationCeiling = input.delegationCeilingCapabilities
    ? new Set(uniqueSorted(input.delegationCeilingCapabilities))
    : null;
  const delegationExceededCapabilities = delegationCeiling
    ? selectedCapabilities.filter((capability) => !delegationCeiling.has(capability))
    : [];

  const applicableAllowAuthorizations: ReusableAuthorization[] = [];
  const applicableDenials: ReusableAuthorization[] = [];
  const expiredAuthorizationIds: string[] = [];
  for (const authorization of input.authorizations) {
    const applicability = authorizationApplies(authorization, input, nowMs);
    if (applicability.expired) expiredAuthorizationIds.push(authorization.authorizationId);
    if (!applicability.applies) continue;
    if (authorization.mode === "DENY") applicableDenials.push(authorization);
    else applicableAllowAuthorizations.push(authorization);
  }

  const supportingAuthorizationsForRole = (selectedRoleId: string): ReusableAuthorization[] => {
    const selectedClosure = closureMap.get(selectedRoleId)!;
    return applicableAllowAuthorizations.filter((authorization) => {
      const authorizedClosure = closureMap.get(authorization.roleId)!;
      return setIsSubset(selectedClosure, authorizedClosure);
    });
  };
  const denialsForRole = (selectedRoleId: string): ReusableAuthorization[] => {
    const selectedClosure = closureMap.get(selectedRoleId)!;
    return applicableDenials.filter((authorization) => {
      const deniedClosure = closureMap.get(authorization.roleId)!;
      return setIsSubset(deniedClosure, selectedClosure);
    });
  };

  const unauthorizedRoleIds = selectedRoleIds.filter((roleId) => supportingAuthorizationsForRole(roleId).length === 0);
  const deniedRoleIds = selectedRoleIds.filter((roleId) => denialsForRole(roleId).length > 0);
  const supportingAuthorizations = selectedRoleIds.flatMap((roleId) =>
    supportingAuthorizationsForRole(roleId),
  );
  const supportingAuthorizationIds = uniqueSorted(
    supportingAuthorizations.map((authorization) => authorization.authorizationId),
  );
  const supportingAuthorizationExpiries = supportingAuthorizationIds.map((authorizationId) => {
    const authorization = supportingAuthorizations.find((item) => item.authorizationId === authorizationId)!;
    return {
      authorizationId,
      expiresAt: new Date(parseTimestamp(
        authorization.expiresAt,
        `authorization ${authorizationId}.expiresAt`,
      )).toISOString(),
    };
  });
  const denialAuthorizationIds = uniqueSorted(selectedRoleIds.flatMap((roleId) =>
    denialsForRole(roleId).map((authorization) => authorization.authorizationId),
  ));
  const requiresPostUntrustedApproval =
    input.plan.consumedUntrustedContext && authorityExpansion;
  const requiredApprovalRoleIds = requiresPostUntrustedApproval
    ? selectedRoleIds
    : unauthorizedRoleIds;

  let status: AuthorityResolutionStatus;
  const reasons: string[] = [];
  if (missingCapabilities.length) {
    status = "DENY";
    reasons.push("required capabilities are absent from the contextual role hierarchy");
  } else if (!selected) {
    status = "DENY";
    reasons.push("no sufficient contextual role set exists");
  } else if (delegationExceededCapabilities.length) {
    status = "DENY";
    reasons.push("selected authority exceeds the delegation ceiling");
  } else if (deniedRoleIds.length) {
    status = "DENY";
    reasons.push("selected authority intersects an explicit role denial");
  } else if (requiresPostUntrustedApproval) {
    status = "REQUIRES_APPROVAL";
    reasons.push("authority expansion after untrusted context requires explicit human approval");
  } else if (unauthorizedRoleIds.length) {
    status = "REQUIRES_APPROVAL";
    reasons.push("selected contextual roles lack applicable authorization");
  } else {
    status = "ALLOW";
    reasons.push("minimum sufficient contextual role set is authorized for this task context");
  }

  const evidence: AuthorityDecisionEvidence = {
    decisionStatus: status,
    resolverVersion: AUTHORITY_RESOLVER_VERSION,
    contractSha256: sha256Text(canonicalJson(input.contract)),
    evaluatedAt: new Date(nowMs).toISOString(),
    taskId: input.plan.taskId,
    planId: input.plan.planId,
    sessionId: input.sessionId ?? null,
    requiredCapabilities,
    selectedRoleIds,
    selectedCapabilities,
    previousActiveCapabilities,
    missingCapabilities,
    unauthorizedRoleIds,
    deniedRoleIds,
    supportingAuthorizationIds,
    supportingAuthorizationExpiries,
    denialAuthorizationIds,
    expiredAuthorizationIds: uniqueSorted(expiredAuthorizationIds),
    delegationCeilingCapabilities: input.delegationCeilingCapabilities
      ? uniqueSorted(input.delegationCeilingCapabilities)
      : null,
    delegationExceededCapabilities,
    consumedUntrustedContext: input.plan.consumedUntrustedContext,
    authorityExpansion,
    reasons,
  };

  return {
    status,
    selectedRoleIds,
    selectedCapabilities,
    requiredApprovalRoleIds: status === "REQUIRES_APPROVAL" ? uniqueSorted(requiredApprovalRoleIds) : [],
    decisionId: sha256Text(canonicalJson(evidence)),
    evidence,
  };
}


export const CAPABILITY_TOKEN_VERSION = "1.0";
export const DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS = 300;
export const MAX_CAPABILITY_TOKEN_TTL_SECONDS = 900;
export const MAX_DECISION_TOKEN_ISSUANCE_AGE_SECONDS = 300;

export type CapabilityTokenPayload = {
  version: "1.0";
  tokenId: string;
  issuer: "agent-foundry";
  algorithm: "EdDSA";
  keyId: string;
  decisionId: string;
  contractSha256: string;
  taskId: string;
  planId: string;
  sessionId: string | null;
  roleIds: string[];
  capabilities: string[];
  issuedAt: string;
  expiresAt: string;
};

export type IssuedCapabilityToken = {
  token: string;
  tokenSha256: string;
  payload: CapabilityTokenPayload;
};

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function requirePrivateSigningKey(privateKeyPem: string) {
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error("capability token signing key must be an Ed25519 private key");
  }
}

function requirePublicVerificationKey(publicKeyPem: string) {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error("capability token verification key must be an Ed25519 public key");
  }
}

function signCapabilityPayload(encodedPayload: string, privateKeyPem: string): string {
  const key = requirePrivateSigningKey(privateKeyPem);
  return sign(
    null,
    Buffer.from(`afct1.${encodedPayload}`, "utf8"),
    key,
  ).toString("base64url");
}

function parseIso(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`invalid capability token ${field}`);
  return parsed;
}

export function issueCapabilityToken(input: {
  resolution: AuthorityResolution;
  privateKeyPem: string;
  keyId: string;
  now: string;
  ttlSeconds?: number;
}): IssuedCapabilityToken {
  const { resolution, privateKeyPem } = input;
  requirePrivateSigningKey(privateKeyPem);
  assertNonEmpty(input.keyId, "capability token keyId");
  const nowMs = parseIso(input.now, "issuance time");
  const decisionEvaluatedAtMs = parseIso(resolution.evidence.evaluatedAt, "decision evaluatedAt");
  if (nowMs < decisionEvaluatedAtMs) {
    throw new Error("capability token issuance time precedes authority decision");
  }
  if (nowMs - decisionEvaluatedAtMs > MAX_DECISION_TOKEN_ISSUANCE_AGE_SECONDS * 1000) {
    throw new Error("capability token issuance rejected stale authority decision");
  }
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_CAPABILITY_TOKEN_TTL_SECONDS) {
    throw new Error(`capability token ttl must be between 1 and ${MAX_CAPABILITY_TOKEN_TTL_SECONDS} seconds`);
  }
  if (resolution.status !== "ALLOW" || resolution.evidence.decisionStatus !== "ALLOW") {
    throw new Error("capability token issuance requires an ALLOW authority decision");
  }
  if (resolution.decisionId !== sha256Text(canonicalJson(resolution.evidence))) {
    throw new Error("capability token issuance rejected non-canonical authority decision evidence");
  }
  if (JSON.stringify(uniqueSorted(resolution.selectedRoleIds))
      !== JSON.stringify(uniqueSorted(resolution.evidence.selectedRoleIds))
    || JSON.stringify(uniqueSorted(resolution.selectedCapabilities))
      !== JSON.stringify(uniqueSorted(resolution.evidence.selectedCapabilities))) {
    throw new Error("capability token issuance rejected inconsistent authority decision projection");
  }
  if (resolution.requiredApprovalRoleIds.length
    || resolution.evidence.missingCapabilities.length
    || resolution.evidence.unauthorizedRoleIds.length
    || resolution.evidence.deniedRoleIds.length
    || resolution.evidence.delegationExceededCapabilities.length
    || (resolution.evidence.consumedUntrustedContext && resolution.evidence.authorityExpansion)) {
    throw new Error("capability token issuance rejected non-final authority decision");
  }
  if (!resolution.selectedCapabilities.length || !resolution.selectedRoleIds.length) {
    throw new Error("capability token issuance requires non-empty active authority");
  }
  if (!resolution.evidence.supportingAuthorizationIds.length
    || resolution.evidence.supportingAuthorizationExpiries.length !== resolution.evidence.supportingAuthorizationIds.length) {
    throw new Error("capability token issuance requires supporting authorization evidence");
  }

  const earliestAuthorizationExpiry = Math.min(
    ...resolution.evidence.supportingAuthorizationExpiries.map((item) => parseIso(item.expiresAt, "authorization expiry")),
  );
  if (earliestAuthorizationExpiry <= nowMs) {
    throw new Error("capability token issuance rejected expired supporting authorization");
  }
  const requestedExpiry = nowMs + ttlSeconds * 1000;
  const expiresAtMs = Math.min(requestedExpiry, earliestAuthorizationExpiry);
  if (expiresAtMs <= nowMs) {
    throw new Error("capability token issuance requires a future expiry");
  }

  const payload: CapabilityTokenPayload = {
    version: CAPABILITY_TOKEN_VERSION,
    tokenId: randomUUID(),
    issuer: "agent-foundry",
    algorithm: "EdDSA",
    keyId: input.keyId,
    decisionId: resolution.decisionId,
    contractSha256: resolution.evidence.contractSha256,
    taskId: resolution.evidence.taskId,
    planId: resolution.evidence.planId,
    sessionId: resolution.evidence.sessionId,
    roleIds: uniqueSorted(resolution.selectedRoleIds),
    capabilities: uniqueSorted(resolution.selectedCapabilities),
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  const encodedPayload = encodeBase64Url(canonicalJson(payload));
  const signature = signCapabilityPayload(encodedPayload, privateKeyPem);
  const token = `afct1.${encodedPayload}.${signature}`;
  return {
    token,
    tokenSha256: sha256Text(token),
    payload,
  };
}

export type CapabilityTokenVerification =
  | { valid: true; payload: CapabilityTokenPayload; tokenSha256: string }
  | { valid: false; reason: string; tokenSha256: string };

export function verifyCapabilityToken(input: {
  token: string;
  publicKeyPem: string;
  expectedKeyId: string;
  now: string;
  expectedTaskId: string;
  expectedPlanId: string;
  expectedDecisionId?: string;
  revokedTokenSha256s: string[];
}): CapabilityTokenVerification {
  const verificationKey = requirePublicVerificationKey(input.publicKeyPem);
  const tokenSha256 = sha256Text(input.token);
  if (!Array.isArray(input.revokedTokenSha256s)) {
    return { valid: false, reason: "revocation_state_required", tokenSha256 };
  }
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== "afct1") {
    return { valid: false, reason: "malformed_token", tokenSha256 };
  }
  const encodedPayload = parts[1]!;
  const suppliedSignature = parts[2]!;
  let suppliedSignatureBytes: Buffer;
  try {
    suppliedSignatureBytes = decodeBase64Url(suppliedSignature);
  } catch {
    return { valid: false, reason: "invalid_signature", tokenSha256 };
  }
  const signatureValid = verify(
    null,
    Buffer.from(`afct1.${encodedPayload}`, "utf8"),
    verificationKey,
    suppliedSignatureBytes,
  );
  if (!signatureValid) {
    return { valid: false, reason: "invalid_signature", tokenSha256 };
  }

  let payload: CapabilityTokenPayload;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")) as CapabilityTokenPayload;
  } catch {
    return { valid: false, reason: "invalid_payload", tokenSha256 };
  }

  if (payload.version !== CAPABILITY_TOKEN_VERSION
    || payload.issuer !== "agent-foundry"
    || payload.algorithm !== "EdDSA") {
    return { valid: false, reason: "unsupported_token", tokenSha256 };
  }
  if (payload.keyId !== input.expectedKeyId) {
    return { valid: false, reason: "key_mismatch", tokenSha256 };
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(payload.tokenId ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(payload.decisionId ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(payload.contractSha256 ?? ""))
    || !payload.taskId || !payload.planId || !Array.isArray(payload.roleIds)
    || !payload.roleIds.length || !Array.isArray(payload.capabilities) || !payload.capabilities.length) {
    return { valid: false, reason: "invalid_payload", tokenSha256 };
  }

  let nowMs: number;
  let issuedAtMs: number;
  let expiresAtMs: number;
  try {
    nowMs = parseIso(input.now, "verification time");
    issuedAtMs = parseIso(payload.issuedAt, "issuedAt");
    expiresAtMs = parseIso(payload.expiresAt, "expiresAt");
  } catch {
    return { valid: false, reason: "invalid_time_claims", tokenSha256 };
  }
  if (expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MAX_CAPABILITY_TOKEN_TTL_SECONDS * 1000) {
    return { valid: false, reason: "invalid_lifetime", tokenSha256 };
  }
  if (nowMs >= expiresAtMs) {
    return { valid: false, reason: "expired", tokenSha256 };
  }
  if (issuedAtMs > nowMs) {
    return { valid: false, reason: "not_yet_valid", tokenSha256 };
  }
  if (payload.taskId !== input.expectedTaskId) {
    return { valid: false, reason: "task_mismatch", tokenSha256 };
  }
  if (payload.planId !== input.expectedPlanId) {
    return { valid: false, reason: "plan_mismatch", tokenSha256 };
  }
  if (input.expectedDecisionId && payload.decisionId !== input.expectedDecisionId) {
    return { valid: false, reason: "decision_mismatch", tokenSha256 };
  }
  if (input.revokedTokenSha256s.includes(tokenSha256)) {
    return { valid: false, reason: "revoked", tokenSha256 };
  }
  return { valid: true, payload, tokenSha256 };
}
