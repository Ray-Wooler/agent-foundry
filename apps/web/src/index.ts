import { createServer } from "node:http";

const port = Number(process.env.WEB_PORT ?? 3000);
const apiBase = process.env.API_PUBLIC_URL ?? "http://localhost:3001";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Agent Foundry</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#151515;background:#f4f5f7}
body{margin:0}.shell{max-width:1080px;margin:0 auto;padding:32px}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
h1{margin:0;font-size:28px}.sub{color:#656b76}
.card{background:white;border:1px solid #dfe3e8;border-radius:14px;padding:20px;margin-bottom:18px;box-shadow:0 2px 10px rgba(0,0,0,.04)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
label{display:block;font-size:13px;font-weight:650;margin-bottom:6px}
input,select,textarea,button{font:inherit}input,select,textarea{width:100%;box-sizing:border-box;border:1px solid #c9ced6;border-radius:8px;padding:10px;background:white}
textarea{min-height:260px;resize:vertical}button{border:0;border-radius:8px;padding:10px 15px;background:#151515;color:white;cursor:pointer;font-weight:650}button[disabled]{opacity:.5;cursor:not-allowed}
.badge{display:inline-block;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:700;background:#eceff3}
pre{white-space:pre-wrap;word-break:break-word;background:#101317;color:#e7edf4;border-radius:10px;padding:16px;max-height:520px;overflow:auto}
.hidden{display:none}.error{color:#a21d1d}.ok{color:#176a3a}
@media(max-width:720px){.grid{grid-template-columns:1fr}.shell{padding:18px}}
</style>
</head>
<body>
<div class="shell">
<header><div><h1>Agent Foundry</h1><div class="sub">Governed agent engineering</div></div><span id="sessionBadge" class="badge">Signed out</span></header>

<section id="loginCard" class="card">
<h2>Sign in</h2>
<div class="grid">
<div><label>Email</label><input id="email" type="email" autocomplete="username" /></div>
<div><label>Password</label><input id="password" type="password" autocomplete="current-password" /></div>
</div>
<p><button id="loginButton">Sign in</button></p>
<div id="loginError" class="error"></div>
</section>

<section id="intakeCard" class="card hidden">
<h2>New agent intake</h2>
<div class="grid">
<div><label>Project</label><select id="project"></select></div>
<div><label>Agent name</label><input id="name" placeholder="Automation Governance Architect" /></div>
<div><label>Agent class</label><select id="agentClass">
<option>specialist</option><option>advisor</option><option>analyst</option><option>builder</option>
<option>orchestrator</option><option>monitor</option><option>communicator</option><option>reviewer</option>
</select></div>
<div><label>Source rights</label><select id="rights">
<option>UNVERIFIED</option><option>VERIFIED</option><option>RESTRICTED</option><option>PROHIBITED</option>
</select></div>
</div>
<p><label>Source prompt</label><textarea id="sourcePrompt" placeholder="Paste the source agent prompt here..."></textarea></p>
<p><button id="submitButton">Create governed candidate</button></p>
<div id="intakeError" class="error"></div>
</section>

<section id="statusCard" class="card hidden">
<div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
<h2>Transformation</h2><span id="statusBadge" class="badge">QUEUED</span>
</div>
<div id="statusMeta" class="sub"></div>
<h3>Reviewer explanation</h3><pre id="explanation">Waiting for worker…</pre>
<h3>Governance validation</h3><pre id="validation">Waiting for worker…</pre>
<h3>Candidate diff</h3><pre id="diff">Waiting for worker…</pre>
<h3>PromptForge stages</h3><pre id="stages">Waiting for worker…</pre>
<h3>Candidate APS</h3><pre id="candidate">Waiting for worker…</pre>
<h3>Transformation record</h3><pre id="record">Waiting for worker…</pre>
<div id="reviewControls">
  <h3>Semantic review</h3>
  <div class="grid">
    <div><label>Decision</label><select id="reviewDecision">
      <option value="APPROVE">Approve</option>
      <option value="REQUEST_CHANGES">Request changes</option>
      <option value="REJECT">Reject</option>
    </select></div>
    <div><label>Rationale</label><input id="reviewRationale" placeholder="Why is this decision justified?" /></div>
  </div>
  <p><label>Requested changes</label><textarea id="requestedChanges" placeholder="Required only when requesting changes"></textarea></p>
  <p><button id="reviewButton">Record review decision</button> <button id="revisionButton" class="hidden">Create revision</button></p>
  <div id="reviewError" class="error"></div>
  <pre id="reviewState">No review recorded.</pre>
</div>

<div id="evaluationControls">
  <h3>Evaluation orchestration</h3>
  <p><button id="createEvaluationPlanButton" class="hidden">Create evaluation plan</button></p>
  <div id="evaluationError" class="error"></div>
  <pre id="evaluationState">No evaluation plan.</pre>
  <div id="humanEvaluationControls" class="hidden">
    <div class="grid">
      <div><label>Human evaluation outcome</label><select id="humanEvalOutcome">
        <option value="PASS">Pass</option>
        <option value="PARTIAL">Partial</option>
        <option value="FAIL">Fail</option>
      </select></div>
      <div><label>Human evaluation rationale</label><input id="humanEvalRationale" placeholder="Why does this evidence support the outcome?" /></div>
    </div>
    <p><button id="humanEvalButton">Submit human evaluation</button></p>
  </div>
  <div id="certReadinessControls" class="hidden">
    <div class="grid">
      <div><label>Certification readiness</label><select id="certReadinessDecision">
        <option value="ELIGIBLE">Eligible</option>
        <option value="NOT_ELIGIBLE">Not eligible</option>
      </select></div>
      <div><label>Readiness rationale</label><input id="certReadinessRationale" placeholder="Why is this version ready or not ready for certification?" /></div>
    </div>
    <p><button id="certReadinessButton">Record certification-readiness decision</button></p>
  </div>
</div>
</section>
</div>
<script>
const API=${JSON.stringify(apiBase)};
let token=sessionStorage.getItem("foundry_token");
let currentTransformationId=null;
let currentEvaluationPlanId=null;
let currentHumanExecutionId=null;
const q=(id)=>document.getElementById(id);
async function api(path,options={}){
  const headers={"content-type":"application/json",...(options.headers||{})};
  if(token) headers.authorization="Bearer "+token;
  const res=await fetch(API+path,{...options,headers});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(body.error||("HTTP "+res.status));
  return body;
}
function showApp(data){
  q("loginCard").classList.add("hidden");q("intakeCard").classList.remove("hidden");
  q("sessionBadge").textContent=data.user.email;
  const select=q("project");select.innerHTML="";
  for(const ws of data.workspaces) for(const p of ws.projects){
    const o=document.createElement("option");o.value=p.id;o.textContent=ws.name+" / "+p.name;select.appendChild(o);
  }
}
async function restore(){if(!token)return;try{showApp(await api("/v1/me"));}catch{token=null;sessionStorage.removeItem("foundry_token");}}
q("loginButton").onclick=async()=>{q("loginError").textContent="";try{
  const data=await api("/v1/auth/login",{method:"POST",body:JSON.stringify({email:q("email").value,password:q("password").value})});
  token=data.token;sessionStorage.setItem("foundry_token",token);showApp(data);
}catch(e){q("loginError").textContent=e.message;}};
q("submitButton").onclick=async()=>{q("intakeError").textContent="";q("submitButton").disabled=true;try{
  const data=await api("/v1/intake",{method:"POST",body:JSON.stringify({
    projectId:q("project").value,name:q("name").value,agentClass:q("agentClass").value,
    rightsStatus:q("rights").value,sourcePrompt:q("sourcePrompt").value
  })});
  q("statusCard").classList.remove("hidden");q("statusBadge").textContent=data.status;
  currentTransformationId=data.transformationId;
  await poll(data.transformationId);
}catch(e){q("intakeError").textContent=e.message;}finally{q("submitButton").disabled=false;}};
async function poll(id){
  for(let i=0;i<120;i++){
    const data=await api("/v1/transformations/"+id);
    q("statusBadge").textContent=data.status;
    q("statusMeta").textContent=[
      data.registryId,
      data.version,
      data.provider && data.model ? (data.provider + " / " + data.model) : null,
      data.validationStatus,
      data.candidateSha256
    ].filter(Boolean).join(" · ");
    if(data.reviewPackage?.explanation) q("explanation").textContent=JSON.stringify(data.reviewPackage.explanation,null,2);
    if(data.reviewPackage?.validation) q("validation").textContent=JSON.stringify(data.reviewPackage.validation,null,2);
    if(data.reviewPackage?.candidateDiff) q("diff").textContent=JSON.stringify(data.reviewPackage.candidateDiff,null,2);
    if(data.stages) q("stages").textContent=JSON.stringify(data.stages,null,2);
    if(data.candidate) q("candidate").textContent=JSON.stringify(data.candidate,null,2);
    if(data.transformationRecord) q("record").textContent=JSON.stringify(data.transformationRecord,null,2);
    q("reviewState").textContent=JSON.stringify({
      semanticReview:data.semanticReview,
      lifecycle:data.lifecycle,
      revisionLineage:data.revisionLineage,
      agentVersionStatus:data.agentVersionStatus
    },null,2);
    if(data.agentVersionStatus==="CANDIDATE" && data.lifecycle?.evaluation_readiness_status==="READY"){
      q("createEvaluationPlanButton").classList.remove("hidden");
    } else {
      q("createEvaluationPlanButton").classList.add("hidden");
    }
    if(data.semanticReview?.decision==="REQUEST_CHANGES" && !data.revisionLineage?.some(x=>x.parent_transformation_id===id)){
      q("revisionButton").classList.remove("hidden");
    } else {
      q("revisionButton").classList.add("hidden");
    }
    if(data.semanticReview) q("reviewButton").disabled=true;
    if(!["QUEUED","PROCESSING"].includes(data.status)) return;
    await new Promise(r=>setTimeout(r,1000));
  }
  q("record").textContent="Polling timed out. Refresh status from the API.";
}


async function pollEvaluationPlan(id){
  currentEvaluationPlanId=id;
  for(let i=0;i<120;i++){
    const data=await api("/v1/evaluation-plans/"+id);
    q("evaluationState").textContent=JSON.stringify(data,null,2);
    const awaiting=(data.executions||[]).find(x=>x.status==="AWAITING_HUMAN");
    if(awaiting){
      currentHumanExecutionId=awaiting.id;
      q("humanEvaluationControls").classList.remove("hidden");
    } else {
      currentHumanExecutionId=null;
      q("humanEvaluationControls").classList.add("hidden");
    }
    if(data.plan?.status==="COMPLETED" && !data.certificationReadinessDecision){
      q("certReadinessControls").classList.remove("hidden");
    } else {
      q("certReadinessControls").classList.add("hidden");
    }
    if(!["READY","RUNNING","AWAITING_HUMAN"].includes(data.plan?.status)) return data;
    if(data.plan?.status==="AWAITING_HUMAN") return data;
    await new Promise(r=>setTimeout(r,1000));
  }
}
q("createEvaluationPlanButton").onclick=async()=>{
  if(!currentTransformationId)return;
  q("evaluationError").textContent="";
  try{
    const data=await api("/v1/transformations/"+currentTransformationId+"/evaluation-plan",{method:"POST",body:"{}"});
    q("createEvaluationPlanButton").classList.add("hidden");
    await pollEvaluationPlan(data.planId);
  }catch(e){q("evaluationError").textContent=e.message;}
};
q("humanEvalButton").onclick=async()=>{
  if(!currentHumanExecutionId||!currentEvaluationPlanId)return;
  q("evaluationError").textContent="";
  try{
    await api("/v1/evaluation-executions/"+currentHumanExecutionId+"/human-review",{
      method:"POST",
      body:JSON.stringify({
        outcome:q("humanEvalOutcome").value,
        rationale:q("humanEvalRationale").value,
        evidence:["Reviewer evidence submitted through Agent Foundry UI"]
      })
    });
    await pollEvaluationPlan(currentEvaluationPlanId);
  }catch(e){q("evaluationError").textContent=e.message;}
};
q("certReadinessButton").onclick=async()=>{
  if(!currentEvaluationPlanId)return;
  q("evaluationError").textContent="";
  try{
    await api("/v1/evaluation-plans/"+currentEvaluationPlanId+"/certification-readiness",{
      method:"POST",
      body:JSON.stringify({
        decision:q("certReadinessDecision").value,
        rationale:q("certReadinessRationale").value
      })
    });
    await pollEvaluationPlan(currentEvaluationPlanId);
  }catch(e){q("evaluationError").textContent=e.message;}
};

q("reviewButton").onclick=async()=>{
  if(!currentTransformationId)return;
  q("reviewError").textContent="";
  try{
    const decision=q("reviewDecision").value;
    const payload={
      decision,
      rationale:q("reviewRationale").value,
      requestedChanges:decision==="REQUEST_CHANGES"?q("requestedChanges").value:undefined
    };
    await api("/v1/transformations/"+currentTransformationId+"/review",{method:"POST",body:JSON.stringify(payload)});
    await poll(currentTransformationId);
  }catch(e){q("reviewError").textContent=e.message;}
};
q("revisionButton").onclick=async()=>{
  if(!currentTransformationId)return;
  q("reviewError").textContent="";
  try{
    const data=await api("/v1/transformations/"+currentTransformationId+"/revisions",{method:"POST",body:"{}"});
    currentTransformationId=data.transformationId;
    q("reviewButton").disabled=false;
    q("reviewRationale").value="";
    q("requestedChanges").value="";
    await poll(currentTransformationId);
  }catch(e){q("reviewError").textContent=e.message;}
};

restore();
</script>
</body></html>`;

createServer((req,res)=>{
  if(req.url!=="/" && req.url!=="/index.html"){res.writeHead(404);res.end("Not found");return;}
  res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
  res.end(html);
}).listen(port,()=>console.log(`agent-foundry-web listening on :${port}`));
