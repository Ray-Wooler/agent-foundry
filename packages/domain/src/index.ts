import { createHash } from "node:crypto";

export type RightsStatus = "VERIFIED" | "UNVERIFIED" | "RESTRICTED" | "PROHIBITED";

export type CandidateRequest = {
  name: string;
  agentClass: "orchestrator" | "specialist" | "builder" | "analyst" | "advisor" | "monitor" | "communicator" | "reviewer";
  sourcePrompt: string;
  rightsStatus: RightsStatus;
};

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
