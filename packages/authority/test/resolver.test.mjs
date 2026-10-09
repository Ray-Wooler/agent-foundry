import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  issueCapabilityToken,
  resolveAuthority,
  verifyCapabilityToken,
} from "../dist/index.js";

const now="2026-10-09T00:00:00.000Z";
const contract={
  contract_version:"1.0",
  authority_model:"contextual_least_privilege",
  roles:[
    {id:"reader",capabilities:["mail.read"],inherits:[]},
    {id:"composer",capabilities:["mail.compose"],inherits:["reader"]},
    {id:"sender",capabilities:["mail.send"],inherits:["composer"]},
    {id:"calendar-reader",capabilities:["calendar.read"],inherits:[]}
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

function input(overrides={}) {
  return {
    contract,
    plan:{
      taskId:"task-1",
      planId:"plan-1",
      requiredCapabilities:["mail.read"],
      consumedUntrustedContext:false
    },
    authorizations:[
      {authorizationId:"auth-reader",roleId:"reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
    ],
    now,
    ...overrides
  };
}

test("allows the minimum sufficient reusable-authorized role",()=>{
  const result=resolveAuthority(input());
  assert.equal(result.status,"ALLOW");
  assert.deepEqual(result.selectedRoleIds,["reader"]);
  assert.deepEqual(result.selectedCapabilities,["mail.read"]);
  assert.equal(result.evidence.authorityExpansion,true);
});

test("chooses narrower reader instead of a broader inherited sender role",()=>{
  const result=resolveAuthority(input({
    authorizations:[
      {authorizationId:"auth-reader",roleId:"reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"},
      {authorizationId:"auth-sender",roleId:"sender",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.deepEqual(result.selectedRoleIds,["reader"]);
});

test("requests approval when the minimum role is not authorized",()=>{
  const result=resolveAuthority(input({authorizations:[]}));
  assert.equal(result.status,"REQUIRES_APPROVAL");
  assert.deepEqual(result.requiredApprovalRoleIds,["reader"]);
});

test("expired authorization does not activate authority",()=>{
  const result=resolveAuthority(input({
    authorizations:[
      {authorizationId:"expired",roleId:"reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-08T00:00:00.000Z"}
    ]
  }));
  assert.equal(result.status,"REQUIRES_APPROVAL");
  assert.deepEqual(result.evidence.expiredAuthorizationIds,["expired"]);
});

test("task authorization is bound to the matching task",()=>{
  const denied=resolveAuthority(input({
    authorizations:[
      {authorizationId:"task-other",roleId:"reader",mode:"ALLOW_TASK",taskId:"other-task",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.equal(denied.status,"REQUIRES_APPROVAL");

  const allowed=resolveAuthority(input({
    authorizations:[
      {authorizationId:"task-current",roleId:"reader",mode:"ALLOW_TASK",taskId:"task-1",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.equal(allowed.status,"ALLOW");
});

test("session authorization is bound to the matching session",()=>{
  const allowed=resolveAuthority(input({
    sessionId:"session-1",
    authorizations:[
      {authorizationId:"session-current",roleId:"reader",mode:"ALLOW_SESSION",sessionId:"session-1",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.equal(allowed.status,"ALLOW");
});

test("post-untrusted authority expansion requires explicit approval despite reusable authorization",()=>{
  const result=resolveAuthority(input({
    plan:{
      taskId:"task-1",
      planId:"plan-2",
      requiredCapabilities:["mail.send"],
      consumedUntrustedContext:true
    },
    authorizations:[
      {authorizationId:"auth-sender",roleId:"sender",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
    ],
    previousActiveRoleIds:["reader"]
  }));
  assert.equal(result.status,"REQUIRES_APPROVAL");
  assert.deepEqual(result.requiredApprovalRoleIds,["sender"]);
  assert.equal(result.evidence.authorityExpansion,true);
});

test("replan inside existing active authority does not require new approval",()=>{
  const result=resolveAuthority(input({
    plan:{
      taskId:"task-1",
      planId:"plan-2",
      requiredCapabilities:["mail.read"],
      consumedUntrustedContext:true
    },
    previousActiveRoleIds:["reader"]
  }));
  assert.equal(result.status,"ALLOW");
  assert.equal(result.evidence.authorityExpansion,false);
});

test("denies required capabilities absent from the hierarchy",()=>{
  const result=resolveAuthority(input({
    plan:{
      taskId:"task-1",
      planId:"plan-1",
      requiredCapabilities:["drive.delete"],
      consumedUntrustedContext:false
    }
  }));
  assert.equal(result.status,"DENY");
  assert.deepEqual(result.evidence.missingCapabilities,["drive.delete"]);
});

test("denies delegated authority above the parent capability ceiling",()=>{
  const result=resolveAuthority(input({
    plan:{
      taskId:"task-1",
      planId:"plan-1",
      requiredCapabilities:["mail.send"],
      consumedUntrustedContext:false
    },
    authorizations:[
      {authorizationId:"auth-sender",roleId:"sender",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
    ],
    delegationCeilingCapabilities:["mail.read","mail.compose"]
  }));
  assert.equal(result.status,"DENY");
  assert.deepEqual(result.evidence.delegationExceededCapabilities,["mail.send"]);
});

test("decision evidence is deterministic for identical inputs",()=>{
  const first=resolveAuthority(input());
  const second=resolveAuthority(input());
  assert.equal(first.decisionId,second.decisionId);
  assert.deepEqual(first.evidence,second.evidence);
});

test("malformed or cyclic contracts fail closed",()=>{
  assert.throws(()=>resolveAuthority(input({contract:{...contract,roles:[]}})),/roles required/);
  const cyclic={
    ...contract,
    roles:[
      {id:"a",capabilities:["a"],inherits:["b"]},
      {id:"b",capabilities:["b"],inherits:["a"]}
    ]
  };
  assert.throws(()=>resolveAuthority(input({contract:cyclic,authorizations:[]})),/cyclic role hierarchy/);
});

test("broader reusable role authorization can activate a narrower contextual role",()=>{
  const result=resolveAuthority(input({
    authorizations:[
      {authorizationId:"auth-sender",roleId:"sender",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.equal(result.status,"ALLOW");
  assert.deepEqual(result.selectedRoleIds,["reader"]);
});

test("explicit denial cannot be bypassed by selecting a broader role",()=>{
  const result=resolveAuthority(input({
    plan:{
      taskId:"task-1",
      planId:"plan-1",
      requiredCapabilities:["mail.send"],
      consumedUntrustedContext:false
    },
    authorizations:[
      {authorizationId:"allow-sender",roleId:"sender",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"},
      {authorizationId:"deny-reader",roleId:"reader",mode:"DENY",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.equal(result.status,"DENY");
  assert.deepEqual(result.evidence.deniedRoleIds,["sender"]);
});

test("denying a broad role does not deny a narrower role",()=>{
  const result=resolveAuthority(input({
    authorizations:[
      {authorizationId:"allow-reader",roleId:"reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"},
      {authorizationId:"deny-sender",roleId:"sender",mode:"DENY",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.equal(result.status,"ALLOW");
});

test("invalid runtime authorization modes fail closed",()=>{
  assert.throws(
    ()=>resolveAuthority(input({
      authorizations:[
        {authorizationId:"bad-mode",roleId:"reader",mode:"ALLOW_FOREVER",expiresAt:"2026-10-10T00:00:00.000Z"}
      ]
    })),
    /bad-mode.mode/
  );
});

test("resolver enforces a bounded exact-search candidate set",()=>{
  const roles=Array.from({length:21},(_,i)=>({
    id:"r-"+String(i).padStart(2,"0"),
    capabilities:["shared"],
    inherits:[]
  }));
  const large={...contract,roles};
  assert.throws(
    ()=>resolveAuthority(input({
      contract:large,
      plan:{taskId:"task-1",planId:"plan-1",requiredCapabilities:["shared"],consumedUntrustedContext:false},
      authorizations:[]
    })),
    /complexity bound exceeded/
  );
});

test("least privilege minimizes excess capabilities before role count",()=>{
  const exactContract={
    ...contract,
    roles:[
      {id:"a-mega",capabilities:["mail.read","calendar.read","mail.delete","calendar.delete"],inherits:[]},
      {id:"b-mail-reader",capabilities:["mail.read"],inherits:[]},
      {id:"c-calendar-reader",capabilities:["calendar.read"],inherits:[]}
    ]
  };
  const result=resolveAuthority(input({
    contract:exactContract,
    plan:{
      taskId:"task-1",
      planId:"plan-1",
      requiredCapabilities:["mail.read","calendar.read"],
      consumedUntrustedContext:false
    },
    authorizations:[
      {authorizationId:"mega-auth",roleId:"a-mega",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"},
      {authorizationId:"mail-auth",roleId:"b-mail-reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"},
      {authorizationId:"cal-auth",roleId:"c-calendar-reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.equal(result.status,"ALLOW");
  assert.deepEqual(result.selectedRoleIds,["b-mail-reader","c-calendar-reader"]);
  assert.deepEqual(result.selectedCapabilities,["calendar.read","mail.read"]);
});

test("decision evidence binds the authority records and contract used",()=>{
  const first=resolveAuthority(input({
    authorizations:[
      {authorizationId:"auth-a",roleId:"reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  const second=resolveAuthority(input({
    authorizations:[
      {authorizationId:"auth-b",roleId:"reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.deepEqual(first.evidence.supportingAuthorizationIds,["auth-a"]);
  assert.deepEqual(second.evidence.supportingAuthorizationIds,["auth-b"]);
  assert.notEqual(first.decisionId,second.decisionId);
  assert.match(first.evidence.contractSha256,/^[a-f0-9]{64}$/);
});

test("deny decisions never imply an approval path",()=>{
  const result=resolveAuthority(input({
    plan:{
      taskId:"task-1",
      planId:"plan-1",
      requiredCapabilities:["mail.send"],
      consumedUntrustedContext:false
    },
    authorizations:[
      {authorizationId:"allow-sender",roleId:"sender",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"},
      {authorizationId:"deny-reader",roleId:"reader",mode:"DENY",expiresAt:"2026-10-10T00:00:00.000Z"}
    ]
  }));
  assert.equal(result.status,"DENY");
  assert.deepEqual(result.requiredApprovalRoleIds,[]);
  assert.deepEqual(result.evidence.denialAuthorizationIds,["deny-reader"]);
});

test("duplicate authorization evidence ids fail closed",()=>{
  assert.throws(
    ()=>resolveAuthority(input({
      authorizations:[
        {authorizationId:"same",roleId:"reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"},
        {authorizationId:"same",roleId:"sender",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-10T00:00:00.000Z"}
      ]
    })),
    /authorization ids must be unique/
  );
});

test("resolver rejects a CAC that weakens fail-closed runtime enforcement",()=>{
  assert.throws(
    ()=>resolveAuthority(input({
      contract:{
        ...contract,
        runtime_enforcement:{required:true,fail_mode:"ALLOW",credential_isolation_required:true}
      }
    })),
    /runtime enforcement contract/
  );
});


const tokenKeyPair=generateKeyPairSync("ed25519");
const privateKeyPem=tokenKeyPair.privateKey.export({format:"pem",type:"pkcs8"}).toString();
const publicKeyPem=tokenKeyPair.publicKey.export({format:"pem",type:"spki"}).toString();

test("issues a short-lived token only from an ALLOW decision",()=>{
  const resolution=resolveAuthority(input());
  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"ci-key-1",
    now:"2026-10-09T00:00:00.000Z",
    ttlSeconds:120
  });
  assert.match(issued.token,/^afct1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(issued.tokenSha256,/^[a-f0-9]{64}$/);
  assert.equal(issued.payload.decisionId,resolution.decisionId);
  assert.equal(issued.payload.taskId,"task-1");
  assert.equal(issued.payload.planId,"plan-1");
  assert.deepEqual(issued.payload.capabilities,["mail.read"]);
  assert.equal(issued.payload.expiresAt,"2026-10-09T00:02:00.000Z");

  const needsApproval=resolveAuthority(input({authorizations:[]}));
  assert.throws(
    ()=>issueCapabilityToken({
      resolution:needsApproval,
      privateKeyPem,
      keyId:"ci-key-1",
      now:"2026-10-09T00:00:00.000Z"
    }),
    /requires an ALLOW/
  );
});

test("token expiry is clamped to supporting authorization expiry",()=>{
  const resolution=resolveAuthority(input({
    authorizations:[
      {authorizationId:"short-auth",roleId:"reader",mode:"AUTHORIZE_ROLE",expiresAt:"2026-10-09T00:01:00.000Z"}
    ]
  }));
  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"ci-key-1",
    now:"2026-10-09T00:00:00.000Z",
    ttlSeconds:300
  });
  assert.equal(issued.payload.expiresAt,"2026-10-09T00:01:00.000Z");
});

test("verifies a token only for its bound task and plan",()=>{
  const resolution=resolveAuthority(input());
  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"ci-key-1",
    now:"2026-10-09T00:00:00.000Z",
    ttlSeconds:120
  });
  const valid=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:00:30.000Z",
    expectedTaskId:"task-1",
    expectedPlanId:"plan-1",
    expectedDecisionId:resolution.decisionId
  });
  assert.equal(valid.valid,true);

  const taskReplay=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:00:30.000Z",
    expectedTaskId:"task-other",
    expectedPlanId:"plan-1"
  });
  assert.deepEqual(taskReplay.valid?null:taskReplay.reason,"task_mismatch");

  const planReplay=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:00:30.000Z",
    expectedTaskId:"task-1",
    expectedPlanId:"plan-other"
  });
  assert.deepEqual(planReplay.valid?null:planReplay.reason,"plan_mismatch");
});

test("expiry, revocation and signature tampering fail closed",()=>{
  const resolution=resolveAuthority(input());
  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"ci-key-1",
    now:"2026-10-09T00:00:00.000Z",
    ttlSeconds:60
  });

  const expired=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:01:00.000Z",
    expectedTaskId:"task-1",
    expectedPlanId:"plan-1"
  });
  assert.deepEqual(expired.valid?null:expired.reason,"expired");

  const revoked=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    now:"2026-10-09T00:00:30.000Z",
    expectedTaskId:"task-1",
    expectedPlanId:"plan-1",
    revokedTokenSha256s:[issued.tokenSha256]
  });
  assert.deepEqual(revoked.valid?null:revoked.reason,"revoked");

  const [prefix,payloadPart,signaturePart]=issued.token.split(".");
  const tamperedPayload=(payloadPart[0]==="A"?"B":"A")+payloadPart.slice(1);
  const tampered=`${prefix}.${tamperedPayload}.${signaturePart}`;
  const invalid=verifyCapabilityToken({
    token:tampered,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:00:30.000Z",
    expectedTaskId:"task-1",
    expectedPlanId:"plan-1"
  });
  assert.deepEqual(invalid.valid?null:invalid.reason,"invalid_signature");
});

test("token issuance rejects stale/tampered decision evidence and excessive ttl",()=>{
  const resolution=resolveAuthority(input());
  const tampered={
    ...resolution,
    evidence:{...resolution.evidence,reasons:["tampered"]}
  };
  assert.throws(
    ()=>issueCapabilityToken({
      resolution:tampered,
      privateKeyPem,
      keyId:"ci-key-1",
      now:"2026-10-09T00:00:00.000Z"
    }),
    /non-canonical/
  );
  assert.throws(
    ()=>issueCapabilityToken({
      resolution,
      privateKeyPem,
      keyId:"ci-key-1",
      now:"2026-10-09T00:00:00.000Z",
      ttlSeconds:901
    }),
    /ttl must be between/
  );
  assert.throws(
    ()=>issueCapabilityToken({
      resolution,
      privateKeyPem,
      keyId:"ci-key-1",
      now:"2026-10-09T00:05:01.000Z"
    }),
    /stale authority decision/
  );
});


test("verification requires explicit revocation state and expected signing key id",()=>{
  const resolution=resolveAuthority(input());
  const issued=issueCapabilityToken({
    resolution,
    privateKeyPem,
    keyId:"ci-key-1",
    now:"2026-10-09T00:00:00.000Z",
    ttlSeconds:60
  });
  const missingRevocation=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-1",
    revokedTokenSha256s:undefined,
    now:"2026-10-09T00:00:30.000Z",
    expectedTaskId:"task-1",
    expectedPlanId:"plan-1"
  });
  assert.equal(missingRevocation.valid,false);
  assert.equal(missingRevocation.reason,"revocation_state_required");

  const wrongKeyId=verifyCapabilityToken({
    token:issued.token,
    publicKeyPem,
    expectedKeyId:"ci-key-2",
    revokedTokenSha256s:[],
    now:"2026-10-09T00:00:30.000Z",
    expectedTaskId:"task-1",
    expectedPlanId:"plan-1"
  });
  assert.equal(wrongKeyId.valid,false);
  assert.equal(wrongKeyId.reason,"key_mismatch");
});
