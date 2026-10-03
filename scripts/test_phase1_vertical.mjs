const api = process.env.API_PUBLIC_URL ?? "http://localhost:3001";
const web = process.env.WEB_PUBLIC_URL ?? "http://localhost:3000";
const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "phase1-test-password";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}, token) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (token) headers.authorization = "Bearer " + token;
  const response = await fetch(api + path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const webResponse = await fetch(web + "/");
assert(webResponse.ok, "web root must respond");
const html = await webResponse.text();
assert(html.includes("Agent Foundry"), "web UI must identify Agent Foundry");

const health = await request("/health");
assert(health.status === "ok", "API health must be ok");

const login = await request("/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});
assert(typeof login.token === "string" && login.token.length > 20, "login must issue opaque token");
assert(login.workspaces?.length > 0, "bootstrap user must have a workspace");
const projectId = login.workspaces[0]?.projects?.[0]?.id;
assert(projectId, "bootstrap workspace must have a project");

const sourcePrompt = `# Example Research Agent
You are a research assistant. Search supplied sources, distinguish evidence from inference, and produce concise findings.
Do not perform external side effects without approval.`;

const intake = await request("/v1/intake", {
  method: "POST",
  body: JSON.stringify({
    projectId,
    name: "Example Research Agent",
    agentClass: "analyst",
    rightsStatus: "UNVERIFIED",
    sourcePrompt,
  }),
}, login.token);

assert(intake.status === "QUEUED", "intake must queue transformation");
assert(typeof intake.transformationId === "string", "transformation id required");

let result;
for (let i = 0; i < 80; i++) {
  result = await request("/v1/transformations/" + intake.transformationId, {}, login.token);
  if (!["QUEUED", "PROCESSING"].includes(result.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

assert(result, "transformation result required");
assert(result.status === "REQUIRES_REVIEW", `expected REQUIRES_REVIEW, got ${result.status}`);
assert(result.candidate, "candidate APS required");
assert(result.transformationRecord?.status === "REQUIRES_REVIEW", "transformation record must require review");
assert(Array.isArray(result.candidate.capabilities) && result.candidate.capabilities.length === 0, "foundation candidate must not invent capabilities");
assert(result.candidate.governance?.authority?.execution?.length === 0, "foundation candidate must not invent execution authority");
assert(result.candidate.governance?.authority?.delegation?.length === 0, "foundation candidate must not invent delegation authority");
assert(result.candidate.governance?.retrieved_content_is_data === true, "source content must remain data");
assert(result.candidate.extensions?.intake?.rights_status === "UNVERIFIED", "rights status must be preserved");

console.log(JSON.stringify({
  status: "PASS",
  transformationId: intake.transformationId,
  registryId: result.registryId,
  candidateSha256: result.candidateSha256,
}, null, 2));
