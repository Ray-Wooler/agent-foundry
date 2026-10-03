const api = process.env.API_PUBLIC_URL ?? "http://localhost:3001";
const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "phase1-test-password";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(path, options = {}, token, expectedStatus) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (token) headers.authorization = "Bearer " + token;
  const response = await fetch(api + path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (expectedStatus !== undefined) {
    assert(response.status === expectedStatus, `${path}: expected ${expectedStatus}, got ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const login = await call("/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});
const token = login.token;
const projectId = login.workspaces?.[0]?.projects?.[0]?.id;
assert(token && projectId, "review test requires authenticated project");

async function createCandidate(name) {
  const intake = await call("/v1/intake", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      name,
      agentClass: "analyst",
      rightsStatus: "UNVERIFIED",
      sourcePrompt: "Research supplied evidence, distinguish inference, and prepare recommendations. Do not execute consequential actions without approval.",
    }),
  }, token);
  for (let i = 0; i < 100; i++) {
    const item = await call("/v1/transformations/" + intake.transformationId, {}, token);
    if (!["QUEUED","PROCESSING"].includes(item.status)) {
      assert(item.status === "REQUIRES_REVIEW", `${name} must reach REQUIRES_REVIEW`);
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} transformation timed out`);
}

// 1. Approval: semantic approval promotes only to CANDIDATE and evaluation readiness.
const approved = await createCandidate("Phase 3 Approval Agent");
const approval = await call("/v1/transformations/" + approved.id + "/review", {
  method: "POST",
  body: JSON.stringify({
    decision: "APPROVE",
    rationale: "Intent, capability boundaries and governance controls are semantically acceptable.",
  }),
}, token);

assert(approval.agentVersionStatus === "CANDIDATE", "approved draft must promote to CANDIDATE");
assert(approval.semanticApprovalStatus === "APPROVED", "semantic approval must be APPROVED");
assert(approval.evaluationReadinessStatus === "READY", "approved candidate must become evaluation-ready");
assert(approval.certificationStatus === "NOT_ELIGIBLE", "semantic approval must not certify");
assert(approval.releaseStatus === "NOT_ELIGIBLE", "semantic approval must not release");

const approvedAfter = await call("/v1/transformations/" + approved.id, {}, token);
assert(approvedAfter.agentVersionStatus === "CANDIDATE", "approved version status must persist");
assert(approvedAfter.semanticReview?.decision === "APPROVE", "immutable semantic review must be visible");
assert(approvedAfter.semanticReview?.reviewer_email === email, "reviewer identity must be retained");
assert(approvedAfter.lifecycle?.evaluation_readiness_status === "READY", "lifecycle must report evaluation readiness");
assert(approvedAfter.lifecycle?.certification_status === "NOT_ELIGIBLE", "certification remains separate");
assert(approvedAfter.lifecycle?.release_status === "NOT_ELIGIBLE", "release remains separate");

await call("/v1/transformations/" + approved.id + "/review", {
  method: "POST",
  body: JSON.stringify({ decision: "APPROVE", rationale: "duplicate" }),
}, token, 409);

// 2. Rejection: remains DRAFT and never becomes evaluation-ready.
const rejected = await createCandidate("Phase 3 Rejection Agent");
const rejection = await call("/v1/transformations/" + rejected.id + "/review", {
  method: "POST",
  body: JSON.stringify({
    decision: "REJECT",
    rationale: "Candidate intent does not meet the required semantic boundary.",
  }),
}, token);
assert(rejection.agentVersionStatus === "DRAFT", "rejected candidate must remain DRAFT");
assert(rejection.semanticApprovalStatus === "REJECTED", "rejection must be recorded");
assert(rejection.evaluationReadinessStatus === "NOT_READY", "rejected candidate must not be evaluation-ready");

// 3. Request changes: reviewed candidate remains immutable and a linked child is generated.
const parent = await createCandidate("Phase 3 Revision Agent");
const parentHash = parent.candidateSha256;
const changeReview = await call("/v1/transformations/" + parent.id + "/review", {
  method: "POST",
  body: JSON.stringify({
    decision: "REQUEST_CHANGES",
    rationale: "The review needs a clearer evidence boundary.",
    requestedChanges: "Clarify that recommendations must identify uncertainty and remain non-executing.",
  }),
}, token);
assert(changeReview.semanticApprovalStatus === "CHANGES_REQUESTED", "change request status must be recorded");
assert(changeReview.agentVersionStatus === "DRAFT", "change-requested candidate remains DRAFT");

const revision = await call("/v1/transformations/" + parent.id + "/revisions", {
  method: "POST",
  body: "{}",
}, token);
assert(revision.parentTransformationId === parent.id, "revision must point to parent");

let child;
for (let i = 0; i < 100; i++) {
  child = await call("/v1/transformations/" + revision.transformationId, {}, token);
  if (!["QUEUED","PROCESSING"].includes(child.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert(child?.status === "REQUIRES_REVIEW", "revision child must reach REQUIRES_REVIEW");
assert(child.agentVersionStatus === "DRAFT", "revision child must start DRAFT");
assert(child.candidate?.extensions?.promptforge?.revision_request_sha256, "revision guidance hash must be preserved");

const parentAfter = await call("/v1/transformations/" + parent.id, {}, token);
assert(parentAfter.candidateSha256 === parentHash, "reviewed parent candidate must not be mutated");
assert(parentAfter.agentVersionStatus === "DRAFT", "change-requested parent remains DRAFT");
const line = parentAfter.revisionLineage?.find((x) => x.child_transformation_id === revision.transformationId);
assert(line, "parent must expose revision lineage");
assert(line.child_agent_version_id, "lineage must finalize child AgentVersion identity");

const childLine = child.revisionLineage?.find((x) => x.parent_transformation_id === parent.id);
assert(childLine?.requested_by_review_id === changeReview.reviewId, "child lineage must bind to change-request review");

await call("/v1/transformations/" + parent.id + "/revisions", {
  method: "POST",
  body: "{}",
}, token, 409);

console.log(JSON.stringify({
  status: "PASS",
  approved: { transformationId: approved.id, reviewId: approval.reviewId },
  rejected: { transformationId: rejected.id, reviewId: rejection.reviewId },
  revision: {
    parentTransformationId: parent.id,
    childTransformationId: revision.transformationId,
    requestedByReviewId: changeReview.reviewId,
  },
}, null, 2));
