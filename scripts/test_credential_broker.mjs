import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  resolveAuthority,
  issueCapabilityToken,
} from "../packages/authority/dist/index.js";
import { enforceInvocation } from "../packages/enforcement/dist/index.js";
import { executeWithBrokeredCredential } from "../packages/credentials/dist/index.js";
import {
  closeDatabase,
  getCapabilityTokenState,
  getCredentialBindingRecord,
  getPolicyEnforcementEvidenceRecord,
  persistAuthorityDecisionRecord,
  persistCapabilityTokenRecord,
  persistCredentialBindingRecord,
  persistCredentialBrokerDecision,
  persistPolicyEnforcementDecision,
  query,
  revokeCapabilityToken,
  setCredentialBindingStatus,
} from "../packages/db/dist/index.js";

const registrySha="c".repeat(64);
const workspaceId="22222222-2222-4222-8222-222222222222";
const otherWorkspaceId="33333333-3333-4333-8333-333333333333";
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

async function main() {
  await query(
    `INSERT INTO workspaces(id,slug,name)
     VALUES ($1,'credential-broker-integration','Credential Broker Integration'),
            ($2,'credential-broker-other','Credential Broker Other')
     ON CONFLICT (id) DO NOTHING`,
    [workspaceId,otherWorkspaceId],
  );

  const decisionAt="2026-10-10T00:00:00.000Z";
  const resolution=resolveAuthority({
    contract,
    plan:{
      taskId:"broker-task",
      planId:"broker-plan",
      requiredCapabilities:["mail.read"],
      consumedUntrustedContext:false
    },
    authorizations:[{
      authorizationId:"broker-auth",
      roleId:"reader",
      mode:"AUTHORIZE_ROLE",
      expiresAt:"2026-10-10T00:10:00.000Z"
    }],
    now:decisionAt
  });
  assert.equal(resolution.status,"ALLOW");
  await persistAuthorityDecisionRecord({
    decisionId:resolution.decisionId,
    status:resolution.status,
    evidence:resolution.evidence
  });

  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"broker-key-1",
    now:decisionAt,
    ttlSeconds:300
  });
  await persistCapabilityTokenRecord(issued);
  const tokenState=await getCapabilityTokenState(issued.tokenSha256);
  assert.ok(tokenState);

  const pep=enforceInvocation({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"broker-key-1",
    now:"2026-10-10T00:01:00.000Z",
    invocation:{
      taskId:"broker-task",
      planId:"broker-plan",
      sessionId:null,
      toolId:"gmail",
      operation:"messages.read"
    },
    binding:{
      bindingId:"gmail.messages.read.v1",
      registrySha256:registrySha,
      toolId:"gmail",
      operation:"messages.read",
      requiredCapabilities:["mail.read"]
    },
    persistedTokenState:tokenState
  });
  assert.equal(pep.outcome,"ALLOW");
  await persistPolicyEnforcementDecision(pep);
  const durablePep=await getPolicyEnforcementEvidenceRecord(pep.evidenceId);
  assert.ok(durablePep);

  const credentialBinding={
    bindingId:"gmail.primary.credential.v1",
    workspaceId,
    registrySha256:registrySha,
    toolId:"gmail",
    operation:"messages.read",
    operationBindingId:"gmail.messages.read.v1",
    provider:"google",
    credentialHandle:"vault://connectors/google/gmail-primary",
    status:"ACTIVE"
  };
  await persistCredentialBindingRecord(credentialBinding);
  const durableBinding=await getCredentialBindingRecord(workspaceId,credentialBinding.bindingId);
  assert.deepEqual(durableBinding,credentialBinding);
  assert.equal(
    await getCredentialBindingRecord(otherWorkspaceId,credentialBinding.bindingId),
    null,
  );

  const broker=await executeWithBrokeredCredential({
    workspaceId,
    enforcement:pep,
    persistedEnforcement:durablePep,
    currentTokenState:tokenState,
    credentialBinding:durableBinding,
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async(decision)=>{
      const persisted=await persistCredentialBrokerDecision(decision);
      return {evidenceId:persisted.evidenceId,auditRecordId:persisted.auditRecordId};
    },
    resolveCredential:async(input)=>{
      assert.equal(input.workspaceId,workspaceId);
      assert.equal(input.credentialHandle,credentialBinding.credentialHandle);
      return {
        value:"integration-secret-token",
        expiresAt:"2026-10-10T00:05:00.000Z"
      };
    },
    consumeCredential:async(input)=>{
      assert.equal(input.workspaceId,workspaceId);
      assert.equal(input.credential,"integration-secret-token");
      return {messages:2};
    }
  });
  assert.equal(broker.outcome,"EXECUTED");
  assert.deepEqual(broker.result,{messages:2});
  assert.match(broker.evidence.authorizationEvidenceId,/^[a-f0-9]{64}$/);

  const authorizationAudit=await query(
    `SELECT action FROM audit_records
     WHERE target_type='credential_broker_decision' AND target_id=$1`,
    [broker.evidence.authorizationEvidenceId],
  );
  assert.equal(authorizationAudit.rows[0]?.action,"credential_use_authorized");

  await persistCredentialBrokerDecision(broker);

  const audit=await query(
    `SELECT evidence
     FROM audit_records
     WHERE target_type='credential_broker_decision' AND target_id=$1`,
    [broker.evidenceId],
  );
  assert.equal(audit.rowCount,1);
  const serialized=JSON.stringify(audit.rows[0].evidence);
  assert.equal(serialized.includes("integration-secret-token"),false);
  assert.equal(serialized.includes("vault://connectors/google/gmail-primary"),false);

  await assert.rejects(
    ()=>persistCredentialBrokerDecision({
      ...broker,
      evidenceId:"f".repeat(64)
    }),
    /evidence id/
  );

  await assert.rejects(
    ()=>persistCredentialBrokerDecision({
      ...broker,
      evidence:{
        ...broker.evidence,
        secret:"must-not-persist"
      }
    }),
    /unexpected fields/
  );

  await revokeCapabilityToken(issued.tokenSha256,"integration revocation");
  let resolvedAfterRevocation=0;
  const revokedBetweenPepAndBroker=await executeWithBrokeredCredential({
    workspaceId,
    enforcement:pep,
    persistedEnforcement:durablePep,
    currentTokenState:tokenState,
    credentialBinding:durableBinding,
    now:"2026-10-10T00:01:02.000Z",
    persistAuthorization:async(decision)=>{
      const persisted=await persistCredentialBrokerDecision(decision);
      return {evidenceId:persisted.evidenceId,auditRecordId:persisted.auditRecordId};
    },
    resolveCredential:async()=>{
      resolvedAfterRevocation++;
      return {value:"must-not-resolve"};
    },
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(revokedBetweenPepAndBroker.outcome,"FAILED");
  assert.equal(revokedBetweenPepAndBroker.evidence.reason,"authorization_audit_failed");
  assert.equal(resolvedAfterRevocation,0);

  await setCredentialBindingStatus(workspaceId,credentialBinding.bindingId,"DISABLED");
  const disabled=await getCredentialBindingRecord(workspaceId,credentialBinding.bindingId);
  assert.equal(disabled.status,"DISABLED");
  let resolved=0;
  const denied=await executeWithBrokeredCredential({
    workspaceId,
    enforcement:pep,
    persistedEnforcement:durablePep,
    currentTokenState:tokenState,
    credentialBinding:disabled,
    now:"2026-10-10T00:01:02.000Z",
    persistAuthorization:async(decision)=>{
      const persisted=await persistCredentialBrokerDecision(decision);
      return {evidenceId:persisted.evidenceId,auditRecordId:persisted.auditRecordId};
    },
    resolveCredential:async()=>{
      resolved++;
      return {value:"should-not-resolve"};
    },
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(denied.outcome,"DENY");
  assert.equal(denied.evidence.reason,"credential_binding_disabled");
  assert.equal(resolved,0);

  await assert.rejects(
    ()=>setCredentialBindingStatus(workspaceId,credentialBinding.bindingId,"ACTIVE"),
    /disabled credential binding cannot be reactivated/
  );

  console.log("CREDENTIAL_BROKER_INTEGRATION_PASS");
}

try {
  await main();
} finally {
  await closeDatabase();
}
