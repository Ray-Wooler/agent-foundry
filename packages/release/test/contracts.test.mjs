import test from "node:test";
import assert from "node:assert/strict";
import { buildFrankAIRegistrationPayload } from "../dist/index.js";

test("FrankAI registration payload matches the published snake_case contract",()=>{
  const payload=buildFrankAIRegistrationPayload({
    publicationRecordId:"publication-1",
    publicationPayload:{
      agent:{registryId:"agent-1",version:"1.2.3"},
      release:{releaseId:"release-1",releaseVersion:"1.2.3",packageSha256:"a".repeat(64)},
      apsVersion:"1.5-alpha",
      runtimeTargets:["generic","openai"],
      capabilities:["research"],
      evaluationRequiredOutcome:"PASS",
      evaluationAggregate:"PASS",
      evaluationRunIds:["run-1"],
      rightsStatus:"VERIFIED",
    },
  });
  assert.deepEqual(payload.release,{release_id:"release-1",release_version:"1.2.3",status:"RELEASED"});
  assert.deepEqual(payload.agent,{id:"agent-1",version:"1.2.3"});
  assert.equal(payload.contract_version,"1.0");
  assert.equal(payload.package_sha256,"a".repeat(64));
  assert.deepEqual(payload.evaluation,{required_outcome:"PASS",observed_outcome:"PASS",run_ids:["run-1"]});
  assert.equal("publicationRecordId" in payload,false);
});

test("incomplete legacy payloads fail closed",()=>{
  assert.throws(()=>buildFrankAIRegistrationPayload({
    publicationRecordId:"legacy",
    publicationPayload:{agent:{registryId:"a",version:"1"},release:{releaseId:"r",releaseVersion:"1",packageSha256:"a".repeat(64)}},
  }),/incomplete/);
});
