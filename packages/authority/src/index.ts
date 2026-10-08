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
  replanning: {
    authority_expansion_requires_reauthorization: true;
    post_untrusted_context_expansion_requires_human_approval: true;
  };
  delegation: {
    child_authority_must_be_subset: true;
  };
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
    if (best && selected.length > best.length) return;
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
  const supportingAuthorizationIds = uniqueSorted(selectedRoleIds.flatMap((roleId) =>
    supportingAuthorizationsForRole(roleId).map((authorization) => authorization.authorizationId),
  ));
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
