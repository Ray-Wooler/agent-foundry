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
assert(token && projectId, "evaluation test requires authenticated project");

const suites = await call("/v1/evaluation-suites", {}, token);
assert(suites.suites.some((x) => x.suite_key === "core-governance-v1"), "core governance suite required");
assert(suites.suites.some((x) => x.suite_key === "human-semantic-quality-v1"), "human quality suite required");
assert(suites.suites.some((x) => x.suite_key === "multi-turn-underspecification-v1"), "multi-turn underspecification suite required");

async function createApprovedCandidate(name) {
  const intake = await call("/v1/intake", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      name,
      agentClass: "analyst",
      rightsStatus: "UNVERIFIED",
      sourcePrompt: "Research supplied evidence and make bounded recommendations. Do not execute external actions.",
    }),
  }, token);

  let candidate;
  for (let i = 0; i < 100; i++) {
    candidate = await call("/v1/transformations/" + intake.transformationId, {}, token);
    if (!["QUEUED","PROCESSING"].includes(candidate.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(candidate?.status === "REQUIRES_REVIEW", "candidate must reach review");

  await call("/v1/transformations/" + candidate.id + "/review", {
    method: "POST",
    body: JSON.stringify({
      decision: "APPROVE",
      rationale: "Semantically approved for evaluation orchestration.",
    }),
  }, token);

  const approved = await call("/v1/transformations/" + candidate.id, {}, token);
  assert(approved.agentVersionStatus === "CANDIDATE", "semantic approval must yield CANDIDATE");
  assert(approved.lifecycle?.evaluation_readiness_status === "READY", "candidate must be evaluation-ready");
  return approved;
}

// PASS path: machine + human required suites.
const approved = await createApprovedCandidate("Phase 4 Passing Agent");
const planCreated = await call("/v1/transformations/" + approved.id + "/evaluation-plan", {
  method: "POST",
  body: "{}",
}, token);
assert(planCreated.agentVersionStatus === "VALIDATED", "plan freeze must promote CANDIDATE to VALIDATED");
assert(planCreated.suites.length === 3, "default plan must contain governance, semantic and underspecification suites");

await call("/v1/evaluation-plans/" + planCreated.planId + "/certification-readiness", {
  method: "POST",
  body: JSON.stringify({ decision: "ELIGIBLE", rationale: "too early" }),
}, token, 409);

let plan;
for (let i = 0; i < 100; i++) {
  plan = await call("/v1/evaluation-plans/" + planCreated.planId, {}, token);
  if (plan.plan?.status === "AWAITING_HUMAN") break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert(plan?.plan?.status === "AWAITING_HUMAN", "plan must pause for human suite");
const machine = plan.executions.find((x) => x.suite_key === "core-governance-v1");
const human = plan.executions.find((x) => x.suite_key === "human-semantic-quality-v1");
const underspec = plan.executions.find((x) => x.suite_key === "multi-turn-underspecification-v1");
assert(machine?.status === "COMPLETED" && machine.outcome === "PASS", "machine suite must pass");
assert(human?.status === "AWAITING_HUMAN", "human suite must await reviewer");
assert(underspec?.status === "QUEUED", "underspecification suite must remain queued behind the first human gate");
assert(plan.plan.agent_version_status === "VALIDATED", "agent remains VALIDATED while human evidence is pending");
assert(plan.plan.certification_status === "NOT_ELIGIBLE", "evaluation progress cannot confer certification eligibility");

const humanResult = await call("/v1/evaluation-executions/" + human.id + "/human-review", {
  method: "POST",
  body: JSON.stringify({
    outcome: "PASS",
    rationale: "Human semantic quality and boundaries are acceptable.",
    evidence: ["Reviewed PromptForge explanation and canonical APS."],
  }),
}, token);
assert(humanResult.planStatus === "RUNNING", "semantic review should release the next required suite");

for (let i = 0; i < 100; i++) {
  plan = await call("/v1/evaluation-plans/" + planCreated.planId, {}, token);
  const next = plan.executions.find((x) => x.suite_key === "multi-turn-underspecification-v1");
  if (next?.status === "AWAITING_HUMAN") break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const underspecReady = plan.executions.find((x) => x.suite_key === "multi-turn-underspecification-v1");
assert(underspecReady?.status === "AWAITING_HUMAN", "underspecification suite must reach behavioural review");

const underspecResult = await call("/v1/evaluation-executions/" + underspecReady.id + "/human-review", {
  method: "POST",
  body: JSON.stringify({
    outcome: "PASS",
    rationale: "Progressive-disclosure behaviour avoids premature answers, targets missing constraints and preserves authority separation.",
    evidence: ["Reviewed multi-turn underspecification scenarios against the canonical APS and agent behaviour."],
  }),
}, token);
assert(underspecResult.planStatus === "COMPLETED", "all required reviews should complete plan");
assert(underspecResult.aggregateOutcome === "PASS", "required suites should aggregate PASS");

plan = await call("/v1/evaluation-plans/" + planCreated.planId, {}, token);
assert(plan.plan.status === "COMPLETED", "plan must be completed");
assert(plan.plan.aggregate_outcome === "PASS", "aggregate must be PASS");
assert(plan.plan.agent_version_status === "EVALUATED", "completed plan must transition to EVALUATED");
assert(plan.plan.evaluation_status === "PASSED", "lifecycle must retain evaluation PASS");
assert(plan.plan.certification_readiness_status === "NOT_REVIEWED", "passing evaluation must not auto-decide readiness");
assert(plan.plan.certification_status === "NOT_ELIGIBLE", "passing evaluation must not auto-mark certification eligible");
assert(plan.plan.release_status === "NOT_ELIGIBLE", "release remains separate");

const readiness = await call("/v1/evaluation-plans/" + planCreated.planId + "/certification-readiness", {
  method: "POST",
  body: JSON.stringify({
    decision: "ELIGIBLE",
    rationale: "Evaluation evidence is sufficient to enter the future certification workflow.",
  }),
}, token);
assert(readiness.certificationStatus === "ELIGIBLE", "explicit readiness decision may mark certification eligible");
assert(readiness.agentVersionStatus === "EVALUATED", "readiness decision must not certify AgentVersion");

plan = await call("/v1/evaluation-plans/" + planCreated.planId, {}, token);
assert(plan.plan.agent_version_status === "EVALUATED", "AgentVersion remains EVALUATED");
assert(plan.plan.certification_status === "ELIGIBLE", "lifecycle may report certification eligibility");
assert(plan.plan.release_status === "NOT_ELIGIBLE", "release remains ineligible");

await call("/v1/evaluation-plans/" + planCreated.planId + "/certification-readiness", {
  method: "POST",
  body: JSON.stringify({ decision: "ELIGIBLE", rationale: "duplicate" }),
}, token, 409);

// FAIL path: completed evaluation is still EVALUATED, but cannot become certification eligible.
const failing = await createApprovedCandidate("Phase 4 Failing Agent");
const failPlan = await call("/v1/transformations/" + failing.id + "/evaluation-plan", {
  method: "POST",
  body: JSON.stringify({ suiteKeys: ["human-semantic-quality-v1"] }),
}, token);

let failState;
for (let i = 0; i < 100; i++) {
  failState = await call("/v1/evaluation-plans/" + failPlan.planId, {}, token);
  if (failState.plan?.status === "AWAITING_HUMAN") break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const failHuman = failState.executions.find((x) => x.status === "AWAITING_HUMAN");
assert(failHuman, "failing plan must await human evidence");

await call("/v1/evaluation-executions/" + failHuman.id + "/human-review", {
  method: "POST",
  body: JSON.stringify({
    outcome: "FAIL",
    rationale: "Candidate quality is insufficient for certification readiness.",
    evidence: ["Human reviewer identified unresolved quality defects."],
  }),
}, token);

failState = await call("/v1/evaluation-plans/" + failPlan.planId, {}, token);
assert(failState.plan.status === "COMPLETED", "failed evaluation plan still completes");
assert(failState.plan.aggregate_outcome === "FAIL", "failed human suite aggregates FAIL");
assert(failState.plan.agent_version_status === "EVALUATED", "completed failed evaluation still becomes EVALUATED");
assert(failState.plan.evaluation_status === "FAILED", "lifecycle must preserve failed evaluation");
assert(failState.plan.certification_status === "NOT_ELIGIBLE", "failed evaluation cannot auto-enable certification");

await call("/v1/evaluation-plans/" + failPlan.planId + "/certification-readiness", {
  method: "POST",
  body: JSON.stringify({ decision: "ELIGIBLE", rationale: "should be rejected" }),
}, token, 409);

const notEligible = await call("/v1/evaluation-plans/" + failPlan.planId + "/certification-readiness", {
  method: "POST",
  body: JSON.stringify({
    decision: "NOT_ELIGIBLE",
    rationale: "Failed evaluation aggregate is not eligible for certification.",
  }),
}, token);
assert(notEligible.certificationStatus === "NOT_ELIGIBLE", "failed evaluation can be explicitly marked not eligible");

console.log(JSON.stringify({
  status: "PASS",
  passingPlan: {
    planId: planCreated.planId,
    aggregateOutcome: plan.plan.aggregate_outcome,
    certificationReadinessDecision: readiness.decisionId,
  },
  failingPlan: {
    planId: failPlan.planId,
    aggregateOutcome: failState.plan.aggregate_outcome,
    certificationStatus: notEligible.certificationStatus,
  },
}, null, 2));
