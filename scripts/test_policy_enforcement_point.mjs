import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueCapabilityToken, resolveAuthority } from "../packages/authority/dist/index.js";
import {
  closeDatabase,
  getCapabilityTokenState,
  persistAuthorityDecisionRecord,
  persistCapabilityTokenRecord,
  persistPolicyEnforcementDecision,
  query,
  revokeCapabilityToken,
} from "../packages/db/dist/index.js";
import { enforceInvocation } from "../packages/enforcement/dist/index.js";

const keyPair=generateKeyPairSync("ed25519");
const privateKeyPem=keyPair.privateKey.export({format:"pem",type:"pkcs8"}).toString();
const publicKeyPem=keyPair.publicKey.export({format:"pem",type:"spki"}).toString();

const contract={
  contract_version:"1.0",
  authority_model:"contextual_least_privilege",
  roles:[{id:"reader",capabilities:["mail.read"],inherits:[]}],
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

const now="2026-10-09T00:00:00.000Z";
const resolution=resolveAuthority({
  contract,
  plan:{
    taskId:"pep-ci-task",
    planId:"pep-ci-plan",
    requiredCapabilities:["mail.read"],
    consumedUntrustedContext:false
  },
  authorizations:[{
    authorizationId:"pep-ci-auth",
    roleId:"reader",
    mode:"AUTHORIZE_ROLE",
    expiresAt:"2026-10-09T00:10:00.000Z"
  }],
  now
});
assert.equal(resolution.status,"ALLOW");

try {
  await persistAuthorityDecisionRecord(resolution);
  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"pep-ci-key",
    now,
    ttlSeconds:120
  });
  await persistCapabilityTokenRecord(issued);

  const persisted=await getCapabilityTokenState(issued.tokenSha256);
  assert.ok(persisted);

  const base={
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"pep-ci-key",
    now:"2026-10-09T00:01:00.000Z",
    invocation:{
      taskId:"pep-ci-task",
      planId:"pep-ci-plan",
      sessionId:null,
      toolId:"gmail",
      operation:"messages.read"
    },
    binding:{
      bindingId:"gmail.messages.read.v1",
      registrySha256:"a".repeat(64),
      toolId:"gmail",
      operation:"messages.read",
      requiredCapabilities:["mail.read"]
    },
    persistedTokenState:persisted
  };

  const allowed=enforceInvocation(base);
  assert.equal(allowed.outcome,"ALLOW");
  assert.equal(allowed.reason,"authorized_capability_token");

  const persistedAllow=await persistPolicyEnforcementDecision(allowed);
  assert.equal(persistedAllow.inserted,true);
  const persistedAllowAgain=await persistPolicyEnforcementDecision(allowed);
  assert.equal(persistedAllowAgain.inserted,false);
  assert.equal(persistedAllowAgain.auditRecordId,persistedAllow.auditRecordId);

  const operationMismatch=enforceInvocation({
    ...base,
    invocation:{...base.invocation,operation:"messages.delete"}
  });
  assert.equal(operationMismatch.outcome,"DENY");
  assert.equal(operationMismatch.reason,"operation_binding_mismatch");

  const missingCapability=enforceInvocation({
    ...base,
    binding:{...base.binding,requiredCapabilities:["mail.send"]}
  });
  assert.equal(missingCapability.outcome,"DENY");
  assert.equal(missingCapability.reason,"capability_not_authorized");

  const missingState=enforceInvocation({...base,persistedTokenState:null});
  assert.equal(missingState.outcome,"DENY");
  assert.equal(missingState.reason,"token_not_persisted");

  const revoked=await revokeCapabilityToken(issued.tokenSha256,"PEP CI revocation");
  assert.equal(revoked.revoked,true);
  const revokedState=await getCapabilityTokenState(issued.tokenSha256);
  assert.ok(revokedState?.revokedAt);

  const deniedAfterRevocation=enforceInvocation({
    ...base,
    persistedTokenState:revokedState
  });
  assert.equal(deniedAfterRevocation.outcome,"DENY");
  assert.equal(deniedAfterRevocation.reason,"token_revoked");

  const persistedDeny=await persistPolicyEnforcementDecision(deniedAfterRevocation);
  assert.equal(persistedDeny.inserted,true);

  const allowAudit=await query(
    "SELECT action,target_type,target_id,evidence FROM audit_records WHERE id=$1",
    [persistedAllow.auditRecordId]
  );
  assert.equal(allowAudit.rows[0]?.action,"protected_invocation_allowed");
  assert.equal(allowAudit.rows[0]?.target_type,"policy_enforcement_decision");
  assert.equal(allowAudit.rows[0]?.target_id,allowed.evidenceId);
  assert.deepEqual(allowAudit.rows[0]?.evidence,allowed.evidence);

  await assert.rejects(
    query("UPDATE audit_records SET action='mutated' WHERE id=$1",[persistedAllow.auditRecordId]),
    /append-only/
  );

  await assert.rejects(
    query(
      `INSERT INTO audit_records(
         actor,action,target_type,target_id,authority_reference,correlation_id,evidence
       ) VALUES (
         'policy-enforcement-point','protected_invocation_allowed',
         'policy_enforcement_decision',$1,$2,$3,$4::jsonb
       )`,
      [
        allowed.evidenceId,
        allowed.evidence.decisionId,
        `${allowed.evidence.taskId}:${allowed.evidence.planId}`,
        JSON.stringify(allowed.evidence)
      ]
    ),
    /duplicate key/
  );

  await assert.rejects(
    query(
      `INSERT INTO audit_records(
         actor,action,target_type,target_id,authority_reference,correlation_id,evidence
       ) VALUES (
         'untrusted-caller','protected_invocation_allowed',
         'policy_enforcement_decision',$1,$2,$3,$4::jsonb
       )`,
      [
        "f".repeat(64),
        allowed.evidence.decisionId,
        `${allowed.evidence.taskId}:${allowed.evidence.planId}`,
        JSON.stringify({...allowed.evidence,tokenSha256:"e".repeat(64)})
      ]
    ),
    /actor is fixed/
  );

  await assert.rejects(
    query(
      `INSERT INTO audit_records(
         actor,action,target_type,target_id,authority_reference,correlation_id,evidence
       ) VALUES (
         'policy-enforcement-point','protected_invocation_allowed',
         'policy_enforcement_decision',$1,$2,$3,$4::jsonb
       )`,
      [
        "d".repeat(64),
        allowed.evidence.decisionId,
        `${allowed.evidence.taskId}:${allowed.evidence.planId}`,
        JSON.stringify({...allowed.evidence,tokenSha256:"c".repeat(64)})
      ]
    ),
    /not backed by active persisted authority/
  );

  await assert.rejects(
    persistPolicyEnforcementDecision({
      ...allowed,
      evidence:{...allowed.evidence,reason:"tampered"}
    }),
    /evidence id does not match/
  );

  console.log("POLICY_ENFORCEMENT_POINT_GATE_PASS");
} finally {
  await closeDatabase();
}
