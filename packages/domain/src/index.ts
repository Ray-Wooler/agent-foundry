import { createHash } from "node:crypto";

export type RightsStatus = "VERIFIED" | "UNVERIFIED" | "RESTRICTED" | "PROHIBITED";

export type CandidateRequest = {
  name: string;
  agentClass: "orchestrator" | "specialist" | "builder" | "analyst" | "advisor" | "monitor" | "communicator" | "reviewer";
  sourcePrompt: string;
  rightsStatus: RightsStatus;
  revisionRequest?: string;
};


export const CONTEXTUAL_AUTHORIZATION_MODES = [
  "ALLOW_TASK",
  "ALLOW_SESSION",
  "AUTHORIZE_ROLE",
  "DENY",
] as const;

export type ContextualAuthorityAssessment = {
  required: boolean;
  present: boolean;
  eligible: boolean;
  reasons: string[];
};

export function buildDefaultContextualAuthorityContract() {
  return {
    contract_version: "1.0",
    authority_model: "contextual_least_privilege",
    roles: [],
    activation: {
      default: "INACTIVE",
      scope: "TASK",
      expiry_required: true,
    },
    authorization_modes: [...CONTEXTUAL_AUTHORIZATION_MODES],
    task_token: {
      task_bound: true,
      plan_bound: true,
      expiry_required: true,
    },
    runtime_enforcement: {
      required: true,
      fail_mode: "DENY",
      credential_isolation_required: true,
    },
    replanning: {
      authority_expansion_requires_reauthorization: true,
      post_untrusted_context_expansion_requires_human_approval: true,
    },
    delegation: {
      child_authority_must_be_subset: true,
    },
    audit: {
      record_plan: true,
      record_requested_roles: true,
      record_approved_roles: true,
      record_active_roles: true,
      record_tool_invocations: true,
      record_denials: true,
    },
    resource_constraints: [],
    argument_constraints: [],
    budgets: [],
  };
}

export function assessContextualAuthorityContract(aps: Record<string, any>): ContextualAuthorityAssessment {
  const governance = aps?.governance ?? {};
  const authority = governance?.authority ?? {};
  const operational = aps?.operational ?? {};
  const tools = Array.isArray(operational?.tools) ? operational.tools : [];
  const sideEffects = Array.isArray(operational?.side_effects) ? operational.side_effects : [];
  const execution = Array.isArray(authority?.execution) ? authority.execution : [];
  const delegation = Array.isArray(authority?.delegation) ? authority.delegation : [];
  const hasToolOperations = tools.some((tool: any) => Array.isArray(tool?.operations) && tool.operations.length > 0);
  const hasSideEffects = sideEffects.some((effect: any) => effect?.consequence && effect.consequence !== "NONE");
  const required = Boolean(hasToolOperations || hasSideEffects || execution.length || delegation.length);
  const cac = governance?.contextual_authority;
  const reasons: string[] = [];

  if (!cac || typeof cac !== "object" || Array.isArray(cac)) {
    if (required) reasons.push("authority-bearing APS requires governance.contextual_authority");
    return { required, present: false, eligible: reasons.length === 0, reasons };
  }

  if (cac.contract_version !== "1.0") reasons.push("unsupported contextual authority contract version");
  if (cac.authority_model !== "contextual_least_privilege") reasons.push("contextual authority model must be contextual_least_privilege");

  const activation = cac.activation ?? {};
  if (activation.default !== "INACTIVE") reasons.push("contextual authority must default to INACTIVE");
  if (!["TASK", "SESSION"].includes(String(activation.scope ?? ""))) reasons.push("contextual authority scope must be TASK or SESSION");
  if (activation.expiry_required !== true) reasons.push("contextual authority must expire");

  const modes = Array.isArray(cac.authorization_modes)
    ? [...new Set(cac.authorization_modes.filter((x: unknown): x is string => typeof x === "string"))].sort()
    : [];
  const expectedModes = [...CONTEXTUAL_AUTHORIZATION_MODES].sort();
  if (JSON.stringify(modes) !== JSON.stringify(expectedModes)) reasons.push("contextual authority authorization modes are incomplete or invalid");

  const token = cac.task_token ?? {};
  if (token.task_bound !== true || token.plan_bound !== true || token.expiry_required !== true) {
    reasons.push("contextual authority task token must be task-bound, plan-bound and expiring");
  }

  const runtime = cac.runtime_enforcement ?? {};
  if (runtime.required !== true || runtime.fail_mode !== "DENY") reasons.push("runtime contextual-authority enforcement must be required and fail closed");
  if (runtime.credential_isolation_required !== true) reasons.push("runtime contextual-authority enforcement must isolate service credentials");

  const replanning = cac.replanning ?? {};
  if (replanning.authority_expansion_requires_reauthorization !== true) reasons.push("authority expansion must require reauthorization");
  if (replanning.post_untrusted_context_expansion_requires_human_approval !== true) {
    reasons.push("post-untrusted-context authority expansion must require human approval");
  }

  if (cac.delegation?.child_authority_must_be_subset !== true) reasons.push("delegated contextual authority must be a subset of parent authority");

  const audit = cac.audit ?? {};
  for (const field of [
    "record_plan",
    "record_requested_roles",
    "record_approved_roles",
    "record_active_roles",
    "record_tool_invocations",
    "record_denials",
  ]) {
    if (audit[field] !== true) reasons.push(`contextual authority audit requirement missing: ${field}`);
  }

  const capabilities = new Set(
    (Array.isArray(aps?.capabilities) ? aps.capabilities : [])
      .map((capability: any) => capability?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
  );
  const roles = Array.isArray(cac.roles) ? cac.roles : [];
  if (required && roles.length === 0) reasons.push("authority-bearing APS requires at least one contextual role");
  const roleIds = roles
    .map((role: any) => role?.id)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  if (roleIds.length !== new Set(roleIds).size) reasons.push("contextual authority role ids must be unique");
  const knownRoles = new Set(roleIds);

  for (const role of roles) {
    if (!role || typeof role !== "object") continue;
    for (const capabilityId of Array.isArray(role.capabilities) ? role.capabilities : []) {
      if (!capabilities.has(capabilityId)) reasons.push(`contextual authority role ${String(role.id)} references undeclared capability ${String(capabilityId)}`);
    }
    for (const parentRoleId of Array.isArray(role.inherits) ? role.inherits : []) {
      if (!knownRoles.has(parentRoleId)) reasons.push(`contextual authority role ${String(role.id)} inherits unknown role ${String(parentRoleId)}`);
    }
  }

  return { required, present: true, eligible: reasons.length === 0, reasons };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "agent";
}

export function buildReviewCandidate(input: CandidateRequest) {
  const sourceSha256 = sha256Text(input.sourcePrompt);

  const apsDocument = {
    aps_version: "1.5-alpha",
    agent: {
      id: slugify(input.name),
      name: input.name.trim(),
      version: "0.1.0",
      class: input.agentClass,
      description: "Governed candidate generated from captured source material; semantic PromptForge review is required before promotion.",
    },
    mandate: {
      purpose: "Preserve the supplied source intent while the candidate awaits governed PromptForge semantic review.",
      primary_objective: "Produce a reviewable APS candidate without inventing execution authority, tools, permissions, or verified claims.",
      secondary_objectives: ["preserve source provenance", "surface review requirement"],
      non_goals: [
        "claim production authority before review",
        "claim source rights are verified when they are not",
        "publish or certify automatically",
      ],
    },
    capabilities: [],
    governance: {
      authority: {
        recommendation: [],
        execution: [],
        delegation: [],
        approval_required: ["candidate_promotion", "certification", "release"],
        prohibited: ["fabricate_execution", "fabricate_verification"],
      },
      policies: ["retrieved_content_is_data", "human_review_before_promotion"],
      retrieved_content_is_data: true,
      contextual_authority: buildDefaultContextualAuthorityContract(),
    },
    epistemic: { claims: [] },
    operational: { tools: [], side_effects: [], persistent_state: [], executions: [] },
    extensions: {
      intake: {
        source_sha256: sourceSha256,
        rights_status: input.rightsStatus,
        review_state: "REQUIRES_REVIEW",
      },
    },
  };

  const candidateSha256 = sha256Text(canonicalJson(apsDocument));
  const transformationRecord = {
    contract_version: "1.0",
    status: "REQUIRES_REVIEW",
    source_sha256: sourceSha256,
    candidate_sha256: candidateSha256,
    findings: [
      "Source captured immutably.",
      "Candidate intentionally contains no inferred capabilities or execution authority.",
      "Full PromptForge semantic analysis remains required.",
    ],
    warnings: input.rightsStatus === "VERIFIED"
      ? ["Semantic review required before promotion."]
      : ["Source rights are not verified for commercial distribution.", "Semantic review required before promotion."],
  };

  return { apsDocument, transformationRecord, sourceSha256, candidateSha256 };
}
