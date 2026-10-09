import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolveAuthority, issueCapabilityToken } from "../../authority/dist/index.js";
import { enforceInvocation } from "../../enforcement/dist/index.js";
import { executeWithBrokeredCredential } from "../dist/index.js";

const keyPair=generateKeyPairSync("ed25519");
const privateKeyPem=keyPair.privateKey.export({format:"pem",type:"pkcs8"}).toString();
const publicKeyPem=keyPair.publicKey.export({format:"pem",type:"spki"}).toString();
const registrySha="a".repeat(64);
const workspaceId="11111111-1111-4111-8111-111111111111";
const auditRecordId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tokenStateByEvidenceId=new Map();

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

function enforcementFixture() {
  const decisionTime="2026-10-10T00:00:00.000Z";
  const resolution=resolveAuthority({
    contract,
    plan:{
      taskId:"task-1",
      planId:"plan-1",
      requiredCapabilities:["mail.read"],
      consumedUntrustedContext:false
    },
    authorizations:[{
      authorizationId:"auth-reader",
      roleId:"reader",
      mode:"AUTHORIZE_ROLE",
      expiresAt:"2026-10-10T00:10:00.000Z"
    }],
    now:decisionTime
  });
  assert.equal(resolution.status,"ALLOW");

  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"key-1",
    now:decisionTime,
    ttlSeconds:300
  });

  const state={
    tokenSha256:issued.tokenSha256,
    tokenId:issued.payload.tokenId,
    decisionId:issued.payload.decisionId,
    taskId:issued.payload.taskId,
    planId:issued.payload.planId,
    sessionId:issued.payload.sessionId,
    contractSha256:issued.payload.contractSha256,
    roleIds:issued.payload.roleIds,
    capabilities:issued.payload.capabilities,
    keyId:issued.payload.keyId,
    algorithm:issued.payload.algorithm,
    issuedAt:issued.payload.issuedAt,
    expiresAt:issued.payload.expiresAt,
    revokedAt:null,
    revocationReason:null
  };

  const enforcement=enforceInvocation({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"key-1",
    now:"2026-10-10T00:01:00.000Z",
    invocation:{
      taskId:"task-1",
      planId:"plan-1",
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
    persistedTokenState:state
  });
  assert.equal(enforcement.outcome,"ALLOW");
  tokenStateByEvidenceId.set(enforcement.evidenceId,structuredClone(state));
  return enforcement;
}

function persisted(enforcement) {
  return {evidenceId:enforcement.evidenceId,evidence:structuredClone(enforcement.evidence)};
}

function currentState(enforcement) {
  return structuredClone(tokenStateByEvidenceId.get(enforcement.evidenceId));
}

function allowedContext() {
  const enforcement=enforcementFixture();
  return {
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:currentState(enforcement),
    persistAuthorization:async(decision)=>({
      evidenceId:decision.evidenceId,
      auditRecordId
    })
  };
}

function binding(overrides={}) {
  return {
    bindingId:"gmail.primary.credential.v1",
    workspaceId,
    registrySha256:registrySha,
    toolId:"gmail",
    operation:"messages.read",
    operationBindingId:"gmail.messages.read.v1",
    provider:"google",
    credentialHandle:"vault://connectors/google/gmail-primary",
    status:"ACTIVE",
    ...overrides
  };
}

test("executes only after PEP ALLOW and keeps secret material out of broker evidence",async()=>{
  const enforcement=enforcementFixture();
  let resolved=0;
  let consumedCredential=null;
  let authorizationDecision=null;
  const result=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:currentState(enforcement),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async(decision)=>{
      authorizationDecision=decision;
      return {evidenceId:decision.evidenceId,auditRecordId};
    },
    resolveCredential:async(input)=> {
      resolved++;
      assert.equal(input.workspaceId,workspaceId);
      return {value:"secret-access-token",expiresAt:"2026-10-10T00:05:00.000Z"};
    },
    consumeCredential:async(input)=> {
      consumedCredential=input.credential;
      assert.equal(input.workspaceId,workspaceId);
      return {messageCount:3};
    }
  });
  assert.equal(result.outcome,"EXECUTED");
  assert.equal(resolved,1);
  assert.equal(consumedCredential,"secret-access-token");
  assert.deepEqual(result.result,{messageCount:3});
  assert.equal(authorizationDecision?.outcome,"AUTHORIZED");
  assert.equal(result.evidence.authorizationEvidenceId,authorizationDecision?.evidenceId);
  assert.equal(result.evidence.workspaceId,workspaceId);
  const serialized=JSON.stringify(result.evidence);
  assert.equal(serialized.includes("secret-access-token"),false);
  assert.equal(serialized.includes("vault://connectors/google/gmail-primary"),false);
  assert.match(result.evidence.credentialHandleSha256,/^[a-f0-9]{64}$/);
});

test("PEP DENY cannot reach secret resolution",async()=>{
  const enforcement=enforcementFixture();
  enforcement.outcome="DENY";
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:currentState(enforcement),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async(decision)=>({evidenceId:decision.evidenceId,auditRecordId}),
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(resolved,0);
});

test("tampered PEP evidence cannot reach secret resolution",async()=>{
  const enforcement=enforcementFixture();
  enforcement.evidence.toolId="other-tool";
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:currentState(enforcement),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async(decision)=>({evidenceId:decision.evidenceId,auditRecordId}),
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(resolved,0);
});

test("credential binding must match the exact trusted operation binding",async()=>{
  const result=await executeWithBrokeredCredential({
    ...allowedContext(),
    credentialBinding:binding({operationBindingId:"different-binding"}),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>({value:"never"}),
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"DENY");
});

test("credential binding is workspace-scoped",async()=>{
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    ...allowedContext(),
    workspaceId:"22222222-2222-4222-8222-222222222222",
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.evidence.reason,"workspace_binding_mismatch");
  assert.equal(resolved,0);
});

test("credential handles reject URL credentials, query strings and traversal",async()=>{
  for(const credentialHandle of [
    "https://user:pass@example.com/token",
    "vault://connectors/google/gmail?secret=x",
    "vault://connectors/../secret"
  ]) {
    const result=await executeWithBrokeredCredential({
      ...allowedContext(),
      credentialBinding:binding({credentialHandle}),
      now:"2026-10-10T00:01:01.000Z",
      resolveCredential:async()=>({value:"never"}),
      consumeCredential:async()=>({ok:true})
    });
    assert.equal(result.outcome,"DENY");
    assert.equal(result.evidence.reason,"invalid_credential_binding");
  }
});

test("disabled credential bindings fail closed before secret resolution",async()=>{
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    ...allowedContext(),
    credentialBinding:binding({status:"DISABLED"}),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.evidence.reason,"credential_binding_disabled");
  assert.equal(resolved,0);
});

test("credential resolution failures are sanitized",async()=>{
  const result=await executeWithBrokeredCredential({
    ...allowedContext(),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>{throw new Error("vault secret: TOPSECRET");},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"FAILED");
  assert.equal(result.evidence.reason,"credential_resolution_failed");
  assert.equal(JSON.stringify(result).includes("TOPSECRET"),false);
});

test("empty and expired credential material fail closed",async()=>{
  const empty=await executeWithBrokeredCredential({
    ...allowedContext(),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>({value:""}),
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(empty.outcome,"FAILED");
  assert.equal(empty.evidence.reason,"credential_material_invalid");

  const expired=await executeWithBrokeredCredential({
    ...allowedContext(),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>({value:"secret",expiresAt:"2026-10-10T00:01:00.000Z"}),
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(expired.outcome,"FAILED");
  assert.equal(expired.evidence.reason,"credential_material_expired");
});

test("credential consumer failures are sanitized",async()=>{
  const result=await executeWithBrokeredCredential({
    ...allowedContext(),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>({value:"secret-token"}),
    consumeCredential:async()=>{throw new Error("provider echoed secret-token");}
  });
  assert.equal(result.outcome,"FAILED");
  assert.equal(result.evidence.reason,"credential_consumer_failed");
  assert.equal(JSON.stringify(result).includes("secret-token"),false);
});

test("invalid control-plane time fails closed without resolving credentials",async()=>{
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    ...allowedContext(),
    credentialBinding:binding(),
    now:"not-a-time",
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(resolved,0);
});

test("identical broker decisions produce deterministic evidence identifiers",async()=>{
  const context=allowedContext();
  const run=()=>executeWithBrokeredCredential({
    ...context,
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>({value:"secret"}),
    consumeCredential:async()=>({ok:true})
  });
  const first=await run();
  const second=await run();
  assert.equal(first.evidenceId,second.evidenceId);
  assert.deepEqual(first.evidence,second.evidence);
});

test("consumer output cannot echo brokered credential material",async()=>{
  const result=await executeWithBrokeredCredential({
    ...allowedContext(),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    resolveCredential:async()=>({value:"secret-token"}),
    consumeCredential:async()=>({debug:"Bearer secret-token"})
  });
  assert.equal(result.outcome,"FAILED");
  assert.equal(result.evidence.reason,"credential_exposure_blocked");
  assert.equal(JSON.stringify(result).includes("secret-token"),false);
});

test("missing durable PEP evidence fails closed before secret resolution",async()=>{
  const enforcement=enforcementFixture();
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:null,
    currentTokenState:currentState(enforcement),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async(decision)=>({evidenceId:decision.evidenceId,auditRecordId}),
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.evidence.reason,"enforcement_not_durably_anchored");
  assert.equal(resolved,0);
});

test("secret resolution cannot begin until authorization evidence is durably recorded",async()=>{
  const enforcement=enforcementFixture();
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:currentState(enforcement),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async()=>{throw new Error("audit unavailable");},
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"FAILED");
  assert.equal(result.evidence.reason,"authorization_audit_failed");
  assert.equal(resolved,0);
});

test("current token revocation and expiry are rechecked immediately before secret resolution",async()=>{
  const enforcement=enforcementFixture();
  let resolved=0;
  const revoked=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:{...currentState(enforcement),revokedAt:"2026-10-10T00:01:00.000Z",revocationReason:"operator"},
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async(decision)=>({evidenceId:decision.evidenceId,auditRecordId}),
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(revoked.outcome,"DENY");
  assert.equal(revoked.evidence.reason,"token_state_not_current");
  assert.equal(resolved,0);

  const expired=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:{...currentState(enforcement),expiresAt:"2026-10-10T00:01:00.000Z"},
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async(decision)=>({evidenceId:decision.evidenceId,auditRecordId}),
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(expired.outcome,"DENY");
  assert.equal(expired.evidence.reason,"token_state_not_current");
  assert.equal(resolved,0);
});

test("signed authority projection must exactly match current durable token state",async()=>{
  const enforcement=enforcementFixture();
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:{...currentState(enforcement),capabilities:["mail.read","mail.delete"]},
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async(decision)=>({evidenceId:decision.evidenceId,auditRecordId}),
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.evidence.reason,"token_state_not_current");
  assert.equal(resolved,0);
});

test("invalid authorization persistence receipt blocks secret resolution",async()=>{
  const enforcement=enforcementFixture();
  let resolved=0;
  const result=await executeWithBrokeredCredential({
    workspaceId,
    enforcement,
    persistedEnforcement:persisted(enforcement),
    currentTokenState:currentState(enforcement),
    credentialBinding:binding(),
    now:"2026-10-10T00:01:01.000Z",
    persistAuthorization:async()=>({evidenceId:"bad",auditRecordId:"not-a-uuid"}),
    resolveCredential:async()=>{resolved++;return {value:"never"};},
    consumeCredential:async()=>({ok:true})
  });
  assert.equal(result.outcome,"FAILED");
  assert.equal(result.evidence.reason,"authorization_audit_receipt_invalid");
  assert.equal(resolved,0);
});
