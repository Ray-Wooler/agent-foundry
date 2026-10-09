import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueCapabilityToken, resolveAuthority } from "../../authority/dist/index.js";
import { enforceInvocation } from "../dist/index.js";

const keyPair=generateKeyPairSync("ed25519");
const privateKeyPem=keyPair.privateKey.export({format:"pem",type:"pkcs8"}).toString();
const publicKeyPem=keyPair.publicKey.export({format:"pem",type:"spki"}).toString();

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

function fixture(capability="mail.read", sessionId=null) {
  const now="2026-10-09T00:00:00.000Z";
  const resolution=resolveAuthority({
    contract,
    plan:{
      taskId:"task-1",
      planId:"plan-1",
      requiredCapabilities:[capability],
      consumedUntrustedContext:false
    },
    authorizations:[
      {
        authorizationId:"auth-1",
        roleId:capability==="mail.send"?"sender":"reader",
        mode:sessionId?"ALLOW_SESSION":"AUTHORIZE_ROLE",
        ...(sessionId?{sessionId}:{}),
        expiresAt:"2026-10-09T00:10:00.000Z"
      }
    ],
    ...(sessionId?{sessionId}:{}),
    now
  });
  assert.equal(resolution.status,"ALLOW");
  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"key-1",
    now,
    ttlSeconds:120
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
  return {issued,state};
}

function request(overrides={}) {
  const {issued,state}=fixture();
  return {
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"key-1",
    now:"2026-10-09T00:01:00.000Z",
    invocation:{
      taskId:"task-1",
      planId:"plan-1",
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
    persistedTokenState:state,
    ...overrides
  };
}

test("allows a persisted, valid token for the trusted operation capability binding",()=>{
  const result=enforceInvocation(request());
  assert.equal(result.outcome,"ALLOW");
  assert.equal(result.reason,"authorized_capability_token");
  assert.deepEqual(result.evidence.requiredCapabilities,["mail.read"]);
  assert.match(result.evidenceId,/^[a-f0-9]{64}$/);
});

test("fails closed when the bearer token has no durable persisted state",()=>{
  const result=enforceInvocation(request({persistedTokenState:null}));
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"token_not_persisted");
});

test("does not trust an invocation to choose its own capability label",()=>{
  const req=request();
  const result=enforceInvocation({
    ...req,
    invocation:{...req.invocation,operation:"messages.delete"}
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"operation_binding_mismatch");
});

test("denies a trusted operation binding whose capability is absent from active authority",()=>{
  const req=request();
  const result=enforceInvocation({
    ...req,
    binding:{...req.binding,requiredCapabilities:["mail.send"]}
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"capability_not_authorized");
});

test("task and plan replay fail closed",()=>{
  const req=request();
  const taskReplay=enforceInvocation({
    ...req,
    invocation:{...req.invocation,taskId:"task-other"}
  });
  assert.equal(taskReplay.outcome,"DENY");
  assert.equal(taskReplay.reason,"token_task_mismatch");

  const planReplay=enforceInvocation({
    ...req,
    invocation:{...req.invocation,planId:"plan-other"}
  });
  assert.equal(planReplay.outcome,"DENY");
  assert.equal(planReplay.reason,"token_plan_mismatch");
});

test("session-bound tokens cannot cross session context",()=>{
  const {issued,state}=fixture("mail.read","session-1");
  const base=request({
    token:issued.token,
    persistedTokenState:state,
    invocation:{
      taskId:"task-1",
      planId:"plan-1",
      sessionId:"session-1",
      toolId:"gmail",
      operation:"messages.read"
    }
  });
  assert.equal(enforceInvocation(base).outcome,"ALLOW");
  const replay=enforceInvocation({
    ...base,
    invocation:{...base.invocation,sessionId:"session-2"}
  });
  assert.equal(replay.outcome,"DENY");
  assert.equal(replay.reason,"token_session_mismatch");
});

test("durable revocation is consulted for every invocation",()=>{
  const req=request();
  const revoked=enforceInvocation({
    ...req,
    persistedTokenState:{
      ...req.persistedTokenState,
      revokedAt:"2026-10-09T00:00:30.000Z",
      revocationReason:"operator revoked"
    }
  });
  assert.equal(revoked.outcome,"DENY");
  assert.equal(revoked.reason,"token_revoked");
});

test("persisted token state must exactly match signed claims",()=>{
  const req=request();
  const result=enforceInvocation({
    ...req,
    persistedTokenState:{
      ...req.persistedTokenState,
      capabilities:["mail.read","mail.send"]
    }
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"persisted_token_state_mismatch");
});

test("expiry is enforced before capability authorization",()=>{
  const req=request({now:"2026-10-09T00:02:00.000Z"});
  const result=enforceInvocation(req);
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"token_expired");
});

test("signing-key identity is bound to persisted state and verifier expectation",()=>{
  const req=request();
  const result=enforceInvocation({...req,expectedKeyId:"key-2"});
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"persisted_key_mismatch");
});

test("identical inputs produce identical enforcement evidence identifiers",()=>{
  const req=request();
  const first=enforceInvocation(req);
  const second=enforceInvocation(req);
  assert.equal(first.evidenceId,second.evidenceId);
  assert.deepEqual(first.evidence,second.evidence);
});

test("malformed trusted binding metadata fails closed",()=>{
  const req=request();
  const result=enforceInvocation({
    ...req,
    binding:{...req.binding,registrySha256:"not-a-digest"}
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"invalid_enforcement_input");
});

test("completely malformed enforcement requests fail closed rather than throwing",()=>{
  const result=enforceInvocation(undefined);
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"invalid_enforcement_input");
});

test("durable state must be for the exact presented bearer hash",()=>{
  const req=request();
  const result=enforceInvocation({
    ...req,
    persistedTokenState:{
      ...req.persistedTokenState,
      tokenSha256:"b".repeat(64)
    }
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"persisted_token_hash_mismatch");
});

test("compound operations require every capability in the trusted binding",()=>{
  const reader=request();
  const denied=enforceInvocation({
    ...reader,
    binding:{
      ...reader.binding,
      requiredCapabilities:["mail.read","mail.send"]
    }
  });
  assert.equal(denied.outcome,"DENY");
  assert.equal(denied.reason,"capability_not_authorized");
  assert.deepEqual(denied.evidence.missingCapabilities,["mail.send"]);

  const {issued,state}=fixture("mail.send");
  const sender=enforceInvocation({
    ...reader,
    token:issued.token,
    persistedTokenState:state,
    binding:{
      ...reader.binding,
      requiredCapabilities:["mail.read","mail.send"]
    }
  });
  assert.equal(sender.outcome,"ALLOW");
});

test("malformed capability arrays cannot crash DENY evidence construction",()=>{
  const req=request();
  const result=enforceInvocation({
    ...req,
    binding:{
      ...req.binding,
      requiredCapabilities:[{},42,null]
    }
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"invalid_enforcement_input");
  assert.deepEqual(result.evidence.requiredCapabilities,[]);
});

test("malformed persisted role or capability arrays fail closed rather than throwing",()=>{
  const req=request();
  const badRoles=enforceInvocation({
    ...req,
    persistedTokenState:{
      ...req.persistedTokenState,
      roleIds:[{}]
    }
  });
  assert.equal(badRoles.outcome,"DENY");
  assert.equal(badRoles.reason,"invalid_persisted_token_state");

  const badCapabilities=enforceInvocation({
    ...req,
    persistedTokenState:{
      ...req.persistedTokenState,
      capabilities:[42]
    }
  });
  assert.equal(badCapabilities.outcome,"DENY");
  assert.equal(badCapabilities.reason,"invalid_persisted_token_state");
});

test("malformed session identity is normalized in denial evidence",()=>{
  const req=request();
  const result=enforceInvocation({
    ...req,
    invocation:{...req.invocation,sessionId:42}
  });
  assert.equal(result.outcome,"DENY");
  assert.equal(result.reason,"invalid_enforcement_input");
  assert.equal(result.evidence.sessionId,"UNAVAILABLE");
});
