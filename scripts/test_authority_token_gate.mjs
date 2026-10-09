import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  issueCapabilityToken,
  resolveAuthority,
  verifyCapabilityToken,
} from "../packages/authority/dist/index.js";
import {
  closeDatabase,
  getCapabilityTokenState,
  persistAuthorityDecisionRecord,
  persistCapabilityTokenRecord,
  query,
  revokeCapabilityToken,
} from "../packages/db/dist/index.js";

const tokenKeyPair=generateKeyPairSync("ed25519");
const privateKeyPem=tokenKeyPair.privateKey.export({format:"pem",type:"pkcs8"}).toString();
const publicKeyPem=tokenKeyPair.publicKey.export({format:"pem",type:"spki"}).toString();

const now="2026-10-09T00:00:00.000Z";
const contract={
  contract_version:"1.0",
  authority_model:"contextual_least_privilege",
  roles:[
    {id:"reader",capabilities:["mail.read"],inherits:[]},
    {id:"sender",capabilities:["mail.send"],inherits:["reader"]}
  ],
  activation:{default:"INACTIVE",scope:"TASK",expiry_required:true},
  authorization_modes:["ALLOW_TASK","ALLOW_SESSION","AUTHORIZE_ROLE","DENY"],
  task_token:{task_bound:true,plan_bound:true,expiry_required:true},
  runtime_enforcement:{required:true,fail_mode:"DENY",credential_isolation_required:true},
  replanning:{
    authority_expansion_requires_reauthorization:true,
    post_untrusted_context_expansion_requires_human_approval:true
  },
  delegation:{child_authority_must_be_subset:true},
  audit:{
    record_plan:true,
    record_requested_roles:true,
    record_approved_roles:true,
    record_active_roles:true,
    record_tool_invocations:true,
    record_denials:true
  }
};

const resolution=resolveAuthority({
  contract,
  plan:{
    taskId:"authority-token-ci-task",
    planId:"authority-token-ci-plan",
    requiredCapabilities:["mail.read"],
    consumedUntrustedContext:false
  },
  authorizations:[
    {
      authorizationId:"authority-token-ci-auth",
      roleId:"reader",
      mode:"AUTHORIZE_ROLE",
      expiresAt:"2026-10-09T00:10:00.000Z"
    }
  ],
  now
});
assert.equal(resolution.status,"ALLOW");

try {
  await query("DELETE FROM capability_token_records WHERE decision_id=$1",[resolution.decisionId])
    .catch(()=>{});
  await query("DELETE FROM authority_decision_records WHERE decision_id=$1",[resolution.decisionId])
    .catch(()=>{});

  const persisted=await persistAuthorityDecisionRecord(resolution);
  assert.equal(persisted.decisionId,resolution.decisionId);
  assert.match(persisted.evidenceSha256,/^[a-f0-9]{64}$/);

  const persistedAgain=await persistAuthorityDecisionRecord(resolution);
  assert.equal(persistedAgain.inserted,false);

  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"ci-key-1",
    now,
    ttlSeconds:120
  });
  await persistCapabilityTokenRecord(issued);
  const tokenAgain=await persistCapabilityTokenRecord(issued);
  assert.equal(tokenAgain.inserted,false);

  const state=await getCapabilityTokenState(issued.tokenSha256);
  assert.ok(state);
  assert.equal(state.decisionId,resolution.decisionId);
  assert.equal(state.taskId,"authority-token-ci-task");
  assert.equal(state.planId,"authority-token-ci-plan");
  assert.equal(state.keyId,"ci-key-1");
  assert.equal(state.algorithm,"EdDSA");
  assert.deepEqual(state.roleIds,["reader"]);
  assert.deepEqual(state.capabilities,["mail.read"]);
  assert.equal(state.revokedAt,null);

  const sameContextReplay=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:01:00.000Z",
    expectedTaskId:"authority-token-ci-task",
    expectedPlanId:"authority-token-ci-plan",
    expectedSessionId:null,
    expectedDecisionId:resolution.decisionId
  });
  assert.equal(sameContextReplay.valid,true);

  const crossPlanReplay=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:01:00.000Z",
    expectedTaskId:"authority-token-ci-task",
    expectedPlanId:"other-plan",
    expectedSessionId:null,
  });
  assert.equal(crossPlanReplay.valid,false);
  assert.equal(crossPlanReplay.reason,"plan_mismatch");

  const expired=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:02:00.000Z",
    expectedTaskId:"authority-token-ci-task",
    expectedPlanId:"authority-token-ci-plan",
    expectedSessionId:null,
  });
  assert.equal(expired.valid,false);
  assert.equal(expired.reason,"expired");

  const revoked=await revokeCapabilityToken(issued.tokenSha256,"CI revocation verification");
  assert.equal(revoked.revoked,true);
  const revokedAgain=await revokeCapabilityToken(issued.tokenSha256,"CI revocation verification");
  assert.equal(revokedAgain.revoked,false);

  const revokedState=await getCapabilityTokenState(issued.tokenSha256);
  assert.ok(revokedState?.revokedAt);
  const rejectedAfterRevocation=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    now:"2026-10-09T00:01:00.000Z",
    expectedTaskId:"authority-token-ci-task",
    expectedPlanId:"authority-token-ci-plan",
    expectedSessionId:null,
    revokedTokenSha256s:[issued.tokenSha256]
  });
  assert.equal(rejectedAfterRevocation.valid,false);
  assert.equal(rejectedAfterRevocation.reason,"revoked");

  await assert.rejects(
    persistCapabilityTokenRecord({...issued,token:issued.token+"tampered"}),
    /hash does not match/
  );
  await assert.rejects(
    persistCapabilityTokenRecord({
      ...issued,
      tokenSha256:issued.tokenSha256,
      payload:{...issued.payload,planId:"payload-mismatch"}
    }),
    /payload does not match bearer token/
  );
  await assert.rejects(
    query(
      `INSERT INTO authority_decision_records(
         decision_id,resolver_version,decision_status,task_id,plan_id,session_id,
         contract_sha256,evidence,evidence_sha256
       ) VALUES ($1,'test-resolver','ALLOW','bad-task','bad-plan',NULL,$2,$3::jsonb,$1)`,
      [
        "d".repeat(64),
        "e".repeat(64),
        JSON.stringify({
          decisionStatus:"DENY",
          resolverVersion:"test-resolver",
          taskId:"bad-task",
          planId:"bad-plan",
          sessionId:null,
          contractSha256:"e".repeat(64)
        })
      ]
    ),
    /check constraint/
  );
  await assert.rejects(
    query("UPDATE capability_token_records SET revocation_reason='changed later' WHERE token_sha256=$1",[issued.tokenSha256]),
    /capability token revocation is immutable/
  );
  await assert.rejects(
    query(
      `INSERT INTO capability_token_records(
         token_id,decision_id,token_sha256,token_version,issuer,algorithm,key_id,
         task_id,plan_id,session_id,contract_sha256,role_ids,capabilities,issued_at,expires_at
       ) VALUES (
         gen_random_uuid(),$1,$2,'1.0','agent-foundry','EdDSA','ci-key-1',
         $3,$4,NULL,$5,'["reader"]'::jsonb,'["mail.read"]'::jsonb,$6,$7
       )`,
      [
        resolution.decisionId,
        "b".repeat(64),
        resolution.evidence.taskId,
        resolution.evidence.planId,
        resolution.evidence.contractSha256,
        now,
        "2026-10-09T00:10:01.000Z"
      ]
    ),
    /expiry exceeds supporting authorization/
  );
  await assert.rejects(
    query(
      `INSERT INTO capability_token_records(
         token_id,decision_id,token_sha256,token_version,issuer,algorithm,key_id,
         task_id,plan_id,session_id,contract_sha256,role_ids,capabilities,issued_at,expires_at
       ) VALUES (
         gen_random_uuid(),$1,$2,'1.0','agent-foundry','EdDSA','ci-key-1',
         $3,$4,NULL,$5,'["reader"]'::jsonb,'["mail.read"]'::jsonb,$6,$7
       )`,
      [
        resolution.decisionId,
        "f".repeat(64),
        resolution.evidence.taskId,
        resolution.evidence.planId,
        resolution.evidence.contractSha256,
        "2026-10-09T00:05:01.000Z",
        "2026-10-09T00:06:01.000Z"
      ]
    ),
    /outside authority decision freshness window/
  );
  await assert.rejects(
    query(
      `INSERT INTO capability_token_records(
         token_id,decision_id,token_sha256,token_version,issuer,algorithm,key_id,
         task_id,plan_id,session_id,contract_sha256,role_ids,capabilities,issued_at,expires_at
       ) VALUES (
         gen_random_uuid(),$1,$2,'1.0','agent-foundry','EdDSA','ci-key-1',
         $3,'wrong-plan',NULL,$4,'["reader"]'::jsonb,'["mail.read"]'::jsonb,$5,$6
       )`,
      [
        resolution.decisionId,
        "c".repeat(64),
        resolution.evidence.taskId,
        resolution.evidence.contractSha256,
        now,
        "2026-10-09T00:01:00.000Z"
      ]
    ),
    /context must match authority decision/
  );

  await assert.rejects(
    query("UPDATE authority_decision_records SET plan_id='mutated' WHERE decision_id=$1",[resolution.decisionId]),
    /authority decision records are immutable/
  );
  await assert.rejects(
    query("UPDATE capability_token_records SET plan_id='mutated' WHERE token_sha256=$1",[issued.tokenSha256]),
    /capability token identity is immutable/
  );
  await assert.rejects(
    query("DELETE FROM capability_token_records WHERE token_sha256=$1",[issued.tokenSha256]),
    /capability token records cannot be deleted/
  );

  const deniedResolution=resolveAuthority({
    contract,
    plan:{
      taskId:"authority-token-denied-task",
      planId:"authority-token-denied-plan",
      requiredCapabilities:["mail.send"],
      consumedUntrustedContext:false
    },
    authorizations:[
      {
        authorizationId:"deny-reader",
        roleId:"reader",
        mode:"DENY",
        expiresAt:"2026-10-09T00:10:00.000Z"
      }
    ],
    now
  });
  assert.equal(deniedResolution.status,"DENY");
  await persistAuthorityDecisionRecord(deniedResolution);
  await assert.rejects(
    query(
      `INSERT INTO capability_token_records(
         token_id,decision_id,token_sha256,token_version,issuer,algorithm,key_id,
         task_id,plan_id,session_id,contract_sha256,role_ids,capabilities,issued_at,expires_at
       ) VALUES (
         gen_random_uuid(),$1,$2,'1.0','agent-foundry','EdDSA','ci-key-1',
         $3,$4,NULL,$5,'["sender"]'::jsonb,'["mail.send"]'::jsonb,$6,$7
       )`,
      [
        deniedResolution.decisionId,
        "a".repeat(64),
        deniedResolution.evidence.taskId,
        deniedResolution.evidence.planId,
        deniedResolution.evidence.contractSha256,
        now,
        "2026-10-09T00:01:00.000Z"
      ]
    ),
    /requires persisted ALLOW decision/
  );

  console.log("AUTHORITY_DECISION_TOKEN_GATE_PASS");
} finally {
  await closeDatabase();
}
