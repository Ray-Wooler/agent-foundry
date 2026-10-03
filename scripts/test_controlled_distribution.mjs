const api=process.env.API_PUBLIC_URL??"http://localhost:3001";
const mock=process.env.MOCK_FRANKAI_URL??"http://127.0.0.1:4010";
const email=process.env.BOOTSTRAP_ADMIN_EMAIL??"admin@example.com";
const password=process.env.BOOTSTRAP_ADMIN_PASSWORD??"phase1-test-password";

function assert(condition,message){if(!condition)throw new Error(message);}
async function call(path,options={},token,expectedStatus){
  const headers={"content-type":"application/json",...(options.headers??{})};
  if(token)headers.authorization="Bearer "+token;
  const response=await fetch(api+path,{...options,headers});
  const body=await response.json().catch(()=>({}));
  if(expectedStatus!==undefined){
    assert(response.status===expectedStatus,`${path}: expected ${expectedStatus}, got ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  if(!response.ok)throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const login=await call("/v1/auth/login",{method:"POST",body:JSON.stringify({email,password})});
const token=login.token;
const projectId=login.workspaces?.[0]?.projects?.[0]?.id;
assert(token&&projectId,"distribution test requires project");

async function createCertifiedCandidate(){
  const intake=await call("/v1/intake",{method:"POST",body:JSON.stringify({
    projectId,
    name:"Phase 6 Distribution Agent",
    agentClass:"analyst",
    rightsStatus:"VERIFIED",
    sourcePrompt:"Research supplied evidence and produce bounded recommendations without external execution."
  })},token);

  let candidate;
  for(let i=0;i<100;i++){
    candidate=await call("/v1/transformations/"+intake.transformationId,{},token);
    if(!["QUEUED","PROCESSING"].includes(candidate.status))break;
    await new Promise(r=>setTimeout(r,200));
  }
  assert(candidate?.status==="REQUIRES_REVIEW","candidate must reach review");

  await call("/v1/transformations/"+candidate.id+"/review",{method:"POST",body:JSON.stringify({
    decision:"APPROVE",rationale:"Semantic approval for distribution acceptance flow."
  })},token);

  const plan=await call("/v1/transformations/"+candidate.id+"/evaluation-plan",{method:"POST",body:"{}"},token);
  let planState;
  for(let i=0;i<100;i++){
    planState=await call("/v1/evaluation-plans/"+plan.planId,{},token);
    if(planState.plan?.status==="AWAITING_HUMAN")break;
    await new Promise(r=>setTimeout(r,200));
  }
  const human=planState.executions.find(x=>x.status==="AWAITING_HUMAN");
  assert(human,"human evaluation required");

  await call("/v1/evaluation-executions/"+human.id+"/human-review",{method:"POST",body:JSON.stringify({
    outcome:"PASS",rationale:"Human evaluation passed.",evidence:["Phase 6 human evaluation evidence"]
  })},token);

  await call("/v1/evaluation-plans/"+plan.planId+"/certification-readiness",{method:"POST",body:JSON.stringify({
    decision:"ELIGIBLE",rationale:"Evaluation evidence is sufficient for certification readiness."
  })},token);

  const cert=await call("/v1/evaluation-plans/"+plan.planId+"/certification",{method:"POST",body:JSON.stringify({
    decision:"CERTIFY",
    rationale:"Certification authority approves this evidence bundle.",
    evidence:["Semantic approval","Evaluation aggregate PASS","Readiness ELIGIBLE"]
  })},token);

  return {planId:plan.planId,agentVersionId:cert.agentVersionId,certificationRecordId:cert.certificationRecordId};
}

const subject=await createCertifiedCandidate();

const pre=await call("/v1/agent-versions/"+subject.agentVersionId+"/authority-state",{},token);
assert(pre.authorityState.packaging_status==="NOT_PACKAGED","must begin unpackaged");
assert(pre.authorityState.publication_status==="NOT_PUBLISHED","must begin unpublished");
assert(pre.authorityState.frankai_registration_status==="NOT_REGISTERED","must begin unregistered");

await call("/v1/agent-versions/"+subject.agentVersionId+"/package",{method:"POST",body:JSON.stringify({
  releaseVersion:"1.0.0",idempotencyKey:"pkg-before-approval-0000"
})},token,409);

const approval=await call("/v1/agent-versions/"+subject.agentVersionId+"/release-approval",{method:"POST",body:JSON.stringify({
  decision:"APPROVE",
  rationale:"Certified version may proceed to controlled packaging.",
  intendedDistribution:"FrankAI internal registry"
})},token);
assert(approval.releaseApprovalStatus==="APPROVED","release approval must precede packaging");

const packageKey="pkg-phase6-idem-0001";
const package1=await call("/v1/agent-versions/"+subject.agentVersionId+"/package",{method:"POST",body:JSON.stringify({
  releaseVersion:"1.0.0",idempotencyKey:packageKey
})},token);
assert(package1.packagingStatus==="PACKAGED","package action must persist immutable package");
assert(package1.publicationStatus==="NOT_PUBLISHED","packaging must not publish");
assert(package1.frankaiRegistrationStatus==="NOT_REGISTERED","packaging must not register");
assert(typeof package1.packageSha256==="string"&&package1.packageSha256.length===64,"package SHA-256 required");
assert(package1.manifest.runtimeTargets.includes("generic")&&package1.manifest.runtimeTargets.includes("openai"),"package must include runtime targets");

const packageReplay=await call("/v1/agent-versions/"+subject.agentVersionId+"/package",{method:"POST",body:JSON.stringify({
  releaseVersion:"1.0.0",idempotencyKey:packageKey
})},token);
assert(packageReplay.idempotentReplay===true,"package same-key retry must replay");
assert(packageReplay.packageRecordId===package1.packageRecordId,"package replay must return same record");
assert(packageReplay.packageSha256===package1.packageSha256,"package replay digest must match");

await call("/v1/agent-versions/"+subject.agentVersionId+"/package",{method:"POST",body:JSON.stringify({
  releaseVersion:"1.0.1",idempotencyKey:"pkg-phase6-conflict-0002"
})},token,409);

let state=await call("/v1/agent-versions/"+subject.agentVersionId+"/authority-state",{},token);
assert(state.releasePackages.length===1,"exactly one package must exist");
assert(state.publications.length===0,"package creation must not publish");

const publicationKey="pub-phase6-idem-0001";
const publication1=await call("/v1/release-packages/"+package1.packageRecordId+"/publish",{method:"POST",body:JSON.stringify({
  channel:"foundry-internal",
  externalReference:"foundry://releases/phase6",
  idempotencyKey:publicationKey
})},token);
assert(publication1.publicationStatus==="PUBLISHED","publication must be explicit");
assert(publication1.frankaiRegistrationStatus==="NOT_REGISTERED","publication must not register");

const publicationReplay=await call("/v1/release-packages/"+package1.packageRecordId+"/publish",{method:"POST",body:JSON.stringify({
  channel:"foundry-internal",
  externalReference:"foundry://releases/phase6",
  idempotencyKey:publicationKey
})},token);
assert(publicationReplay.idempotentReplay===true,"publication same-key retry must replay");
assert(publicationReplay.publicationRecordId===publication1.publicationRecordId,"publication replay must return same record");

await call("/v1/release-packages/"+package1.packageRecordId+"/publish",{method:"POST",body:JSON.stringify({
  channel:"foundry-internal",idempotencyKey:"pub-phase6-conflict-0002"
})},token,409);

state=await call("/v1/agent-versions/"+subject.agentVersionId+"/authority-state",{},token);
assert(state.publications.length===1,"exactly one publication must exist");
assert(!state.publications[0].frankai_registration_id,"publication must still be unregistered");

async function rawRegister(key){
  const response=await fetch(api+"/v1/publications/"+publication1.publicationRecordId+"/frankai-register",{
    method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer "+token},
    body:JSON.stringify({idempotencyKey:key}),
  });
  return {key,status:response.status,body:await response.json().catch(()=>({}))};
}

const concurrentRegistrations=await Promise.all([
  rawRegister("reg-phase6-idem-0001"),
  rawRegister("reg-phase6-concurrent-0002"),
]);
assert(concurrentRegistrations.filter(x=>x.status===201).length===1,"one concurrent registration request must win");
assert(concurrentRegistrations.filter(x=>x.status===409).length===1,"different-key concurrent registration must receive controlled 409");
const winningRegistration=concurrentRegistrations.find(x=>x.status===201);
const registrationKey=winningRegistration.key;
const registration1=winningRegistration.body;
assert(registration1.frankaiRegistrationStatus==="REGISTERED","registration must succeed");
assert(typeof registration1.registrationReference==="string"&&registration1.registrationReference.length>0,"registration reference required");

const registrationReplay=await call("/v1/publications/"+publication1.publicationRecordId+"/frankai-register",{method:"POST",body:JSON.stringify({
  idempotencyKey:registrationKey
})},token);
assert(registrationReplay.idempotentReplay===true,"registration same-key retry must replay");
assert(registrationReplay.registrationRecordId===registration1.registrationRecordId,"registration replay must return same record");
assert(registrationReplay.registrationReference===registration1.registrationReference,"registration replay reference must match");

await call("/v1/publications/"+publication1.publicationRecordId+"/frankai-register",{method:"POST",body:JSON.stringify({
  idempotencyKey:"reg-phase6-conflict-0002"
})},token,409);

state=await call("/v1/agent-versions/"+subject.agentVersionId+"/authority-state",{},token);
assert(state.authorityState.packaging_status==="PACKAGED","lifecycle must report PACKAGED");
assert(state.authorityState.publication_status==="PUBLISHED","lifecycle must report PUBLISHED");
assert(state.authorityState.frankai_registration_status==="REGISTERED","lifecycle must report REGISTERED");
assert(state.releasePackages.length===1,"one immutable package record required");
assert(state.publications.length===1,"one immutable publication record required");
assert(state.publications[0].frankai_registration_id===registration1.registrationRecordId,"registration must attach to publication");

const mockState=await fetch(mock+"/_state").then(r=>r.json());
assert(mockState.requests===1,"safe API replay must avoid duplicate outbound FrankAI registration calls");
assert(mockState.registrations.length===1,"mock registry must contain one registration");

console.log(JSON.stringify({
  status:"PASS",
  agentVersionId:subject.agentVersionId,
  package:{id:package1.packageRecordId,sha256:package1.packageSha256},
  publication:{id:publication1.publicationRecordId,channel:publication1.channel},
  frankai:{id:registration1.registrationRecordId,reference:registration1.registrationReference},
  outboundRegistryRequests:mockState.requests
},null,2));
