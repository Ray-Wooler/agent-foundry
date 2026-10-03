import { createServer } from "node:http";
import {
  DeterministicPromptForgeProvider,
  OpenAIResponsesProvider,
  PromptForgeEngine,
} from "../packages/promptforge/dist/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const engine = new PromptForgeEngine(new DeterministicPromptForgeProvider());
const result = await engine.transform({
  name: "Research and Change Agent",
  agentClass: "analyst",
  rightsStatus: "UNVERIFIED",
  sourcePrompt: "Research the supplied sources, explain findings, and send or change things only when appropriate.",
});

assert(result.stages.length === 5, "expected five PromptForge stages");
assert(result.apsDocument.capabilities.length >= 1, "expected extracted capabilities");
assert(result.apsDocument.governance.authority.execution.length === 0, "execution authority must be hard-clamped");
assert(result.apsDocument.governance.authority.delegation.length === 0, "delegation authority must be hard-clamped");
assert(result.apsDocument.operational.tools.length === 0, "runtime tools must remain unbound");
assert(result.reviewPackage.validation.status === "PASS", "candidate validation must pass");
assert(result.reviewPackage.candidateDiff.length > 0, "review diff must be generated");
assert(result.transformationRecord.status === "REQUIRES_REVIEW", "candidate must remain review-gated");

const mock = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/responses") {
    res.writeHead(404); res.end(); return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  assert(parsed.model === "mock-model", "OpenAI adapter must send configured model");
  assert(Array.isArray(parsed.input) && parsed.input.length === 2, "OpenAI adapter must send system and user input");

  const payload = JSON.stringify({
    purpose: "Mock purpose",
    primaryObjective: "Mock objective",
    secondaryObjectives: [],
    nonGoals: [],
    summary: "Mock summary",
  });
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify({
    id: "resp_mock_123",
    output: [{ content: [{ text: payload }] }],
  }));
});

await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const address = mock.address();
if (!address || typeof address === "string") throw new Error("mock server address unavailable");

try {
  const provider = new OpenAIResponsesProvider("test-key", "mock-model", `http://127.0.0.1:${address.port}`);
  const response = await provider.generate("INTENT_ANALYSIS", "source", {});
  assert(response.metadata.provider === "openai", "provider identity must be openai");
  assert(response.metadata.model === "mock-model", "model identity must be retained");
  assert(response.metadata.requestId === "resp_mock_123", "response id must be retained");
  assert(response.data.purpose === "Mock purpose", "OpenAI response JSON must be parsed");
} finally {
  await new Promise((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
}

console.log(JSON.stringify({
  status: "PASS",
  deterministicStages: result.stages.map((x) => x.stage),
  candidateSha256: result.candidateSha256,
  validation: result.reviewPackage.validation.status,
  openAIAdapter: "PASS",
}, null, 2));
