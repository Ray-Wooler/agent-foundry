import test from "node:test";
import assert from "node:assert/strict";
import { resolveAuthority } from "../dist/index.js";

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
  replanning:{
    authority_expansion_requires_reauthorization:true,
    post_untrusted_context_expansion_requires_human_approval:true
  },
  delegation:{child_authority_must_be_subset:true}
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
