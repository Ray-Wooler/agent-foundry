const api = process.env.API_PUBLIC_URL ?? "http://localhost:3001";
const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "phase1-test-password";

function assert(condition, message) { if (!condition) throw new Error(message); }

async function call(path, options = {}, token, expectedStatus) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (token) headers.authorization = "Bearer " + token;
  const response = await fetch(api + path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (expectedStatus !== undefined) {
    assert(response.status === expectedStatus, `${path}: expected ${expectedStatus}, got ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const login = await call("/v1/auth/login", { method:"POST", body:JSON.stringify({email,password}) });
const token=login.token;
const projectId=login.workspaces?.[0]?.projects?.[0]?.id;
assert(token&&projectId,"certification test requires project");

async function createCertifiedEligibleCandidate(name, rightsStatus="VERIFIED") {
  const intake=await call("/v1/intake",{method:"POST",body:JSON.stringify({
    projectId,name,agentClass:"analyst",rightsStatus,
    sourcePrompt:"Research supplied evidence and produce bounded recommendations without external execution."
  })},token);

  let candidate;
  for(let i=0;i<100;i++){
    candidate=await call("/v1/transformations/"+intake.transformationId,{},token);
    if(!["QUEUED","PROCESSING"].includes(candidate.status)) break;
    await new Promise(r=>setTimeout(r,200));
  }
  assert(candidate?.status==="REQUIRES_REVIEW","candidate review state required");

  await call("/v1/transformations/"+candidate.id+"/review",{method:"POST",body:JSON.stringify({
    decision:"APPROVE",rationale:"Semantic review approved."
  })},token);

  const plan=await call("/v1/transformations/"+candidate.id+"/evaluation-plan",{method:"POST",body:"{}"},token);

  let state;
  for(let i=0;i<100;i++){
    state=await call("/v1/evaluation-plans/"+plan.planId,{},token);
    if(state.plan?.status==="AWAITING_HUMAN") break;
    await new Promise(r=>setTimeout(r,200));
  }
  const human=state.executions.find(x=>x.status==="AWAITING_HUMAN");
  assert(human,"human evaluation required");

  await call("/v1/evaluation-executions/"+human.id+"/human-review",{method:"POST",body:JSON.stringify({
    outcome:"PASS",rationale:"Human quality evaluation passed.",evidence:["Human quality review evidence"]
  })},token);

  state=await call("/v1/evaluation-plans/"+plan.planId,{},token);
  assert(state.plan.aggregate_outcome==="PASS"&&state.plan.agent_version_status==="EVALUATED","PASS EVALUATED state required");

  await call("/v1/evaluation-plans/"+plan.planId+"/certification-readiness",{method:"POST",body:JSON.stringify({
    decision:"ELIGIBLE",rationale:"Evaluation evidence supports certification readiness."
  })},token);

  state=await call("/v1/evaluation-plans/"+plan.planId,{},token);
  assert(state.plan.certification_status==="ELIGIBLE","certification eligibility required");
  return {candidate,planId:plan.planId,agentVersionId:state.plan.agent_version_id};
}

const subject=await createCertifiedEligibleCandidate("Phase 5 Certification Agent","VERIFIED");

const cert=await call("/v1/evaluation-plans/"+subject.planId+"/certification",{method:"POST",body:JSON.stringify({
  decision:"CERTIFY",
  rationale:"Certification authority accepts the complete evidence bundle.",
  evidence:["Semantic approval","Evaluation aggregate PASS","Certification readiness ELIGIBLE"]
})},token);

assert(cert.agentVersionStatus==="CERTIFIED","CERTIFY must promote EVALUATED to CERTIFIED");
assert(cert.releaseApprovalStatus==="NOT_REVIEWED","certification must not auto-approve release");
assert(cert.packagingStatus==="NOT_PACKAGED","certification must not package");
assert(cert.publicationStatus==="NOT_PUBLISHED","certification must not publish");
assert(cert.frankaiRegistrationStatus==="NOT_REGISTERED","certification must not register with FrankAI");

let authority=await call("/v1/agent-versions/"+subject.agentVersionId+"/authority-state",{},token);
assert(authority.authorityState.agent_version_status==="CERTIFIED","authority state must show CERTIFIED");
assert(!authority.authorityState.release_approval_id,"release approval must be absent after certification");
assert(authority.releasePackages.length===0,"no package record after certification");
assert(authority.publications.length===0,"no publication after certification");

await call("/v1/evaluation-plans/"+subject.planId+"/certification",{method:"POST",body:JSON.stringify({
  decision:"CERTIFY",rationale:"duplicate",evidence:["duplicate"]
})},token,409);

const approval=await call("/v1/agent-versions/"+subject.agentVersionId+"/release-approval",{method:"POST",body:JSON.stringify({
  decision:"APPROVE",
  rationale:"Certified version is approved to proceed to controlled packaging.",
  intendedDistribution:"FrankAI internal registry"
})},token);

assert(approval.releaseApprovalStatus==="APPROVED","release approval must be explicit");
assert(approval.releaseStatus==="ELIGIBLE","approved version may become release-eligible");
assert(approval.packagingStatus==="NOT_PACKAGED","release approval must not package");
assert(approval.publicationStatus==="NOT_PUBLISHED","release approval must not publish");
assert(approval.frankaiRegistrationStatus==="NOT_REGISTERED","release approval must not register");

authority=await call("/v1/agent-versions/"+subject.agentVersionId+"/authority-state",{},token);
assert(authority.authorityState.release_approval_decision==="APPROVE","authority state must retain release approval");
assert(authority.releasePackages.length===0,"approval still must not create package");
assert(authority.publications.length===0,"approval still must not publish");

await call("/v1/agent-versions/"+subject.agentVersionId+"/release-approval",{method:"POST",body:JSON.stringify({
  decision:"APPROVE",rationale:"duplicate",intendedDistribution:"duplicate"
})},token,409);

// Rights-incompatible source may certify but cannot receive APPROVE release decision.
const restricted=await createCertifiedEligibleCandidate("Phase 5 Rights Gate Agent","UNVERIFIED");
await call("/v1/evaluation-plans/"+restricted.planId+"/certification",{method:"POST",body:JSON.stringify({
  decision:"CERTIFY",rationale:"Technical certification passed despite unverified distribution rights.",
  evidence:["Evaluation aggregate PASS","Readiness ELIGIBLE"]
})},token);

await call("/v1/agent-versions/"+restricted.agentVersionId+"/release-approval",{method:"POST",body:JSON.stringify({
  decision:"APPROVE",rationale:"should fail",intendedDistribution:"public"
})},token,409);

const denied=await call("/v1/agent-versions/"+restricted.agentVersionId+"/release-approval",{method:"POST",body:JSON.stringify({
  decision:"DENY",rationale:"Distribution rights are not verified.",intendedDistribution:"none"
})},token);
assert(denied.releaseApprovalStatus==="DENIED","rights-incompatible release can be explicitly denied");

console.log(JSON.stringify({
  status:"PASS",
  certified:{
    agentVersionId:subject.agentVersionId,
    certificationRecordId:cert.certificationRecordId,
    releaseApprovalId:approval.releaseApprovalId,
    packagingStatus:approval.packagingStatus,
    publicationStatus:approval.publicationStatus,
    frankaiRegistrationStatus:approval.frankaiRegistrationStatus
  },
  rightsGate:{
    agentVersionId:restricted.agentVersionId,
    releaseApprovalStatus:denied.releaseApprovalStatus
  }
},null,2));
