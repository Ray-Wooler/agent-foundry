import { hashPassword } from "../packages/auth/dist/index.js";
import { query, transaction, closeDatabase } from "../packages/db/dist/index.js";

const api=process.env.API_PUBLIC_URL??"http://localhost:3001";
const password=process.env.TENANT_ISOLATION_PASSWORD??"phase7-tenant-password";
const email="tenant-b@example.com";

function assert(condition,message){if(!condition)throw new Error(message);}
async function apiCall(path,options={},token){
  const headers={"content-type":"application/json",...(options.headers??{})};
  if(token)headers.authorization="Bearer "+token;
  const response=await fetch(api+path,{...options,headers});
  const body=await response.json().catch(()=>({}));
  return {response,body};
}

// Wait for durable artifacts created by the controlled-distribution flow.
let artifacts;
for(let i=0;i<120;i++){
  artifacts=await query(
    `SELECT id,kind,object_key,sha256,storage_status,attempts,last_error
     FROM artifact_objects
     ORDER BY created_at`
  );
  if(artifacts.rows.length>=3 && artifacts.rows.every(x=>x.storage_status==="STORED"))break;
  await new Promise(r=>setTimeout(r,250));
}
assert(artifacts.rows.length>=3,"expected package/publication/registration artifact records");
assert(artifacts.rows.every(x=>x.storage_status==="STORED"),"all distribution artifacts must reach STORED");

// Inject one malformed job to prove dead-letter behavior.
const bootstrapWorkspace=await query(
  `SELECT w.id
   FROM workspaces w
   JOIN workspace_memberships m ON m.workspace_id=w.id
   JOIN app_users u ON u.id=m.user_id
   WHERE u.email=$1
   ORDER BY w.created_at
   LIMIT 1`,
  [process.env.BOOTSTRAP_ADMIN_EMAIL??"admin@example.com"],
);
const workspaceId=bootstrapWorkspace.rows[0]?.id;
assert(workspaceId,"bootstrap workspace missing");

const deadJob=await query(
  `INSERT INTO operational_jobs(workspace_id,job_type,payload,max_attempts)
   VALUES ($1,'STORE_ARTIFACT','{}'::jsonb,1)
   RETURNING id`,
  [workspaceId],
);
const deadJobId=deadJob.rows[0].id;
let deadState;
for(let i=0;i<80;i++){
  deadState=await query(
    "SELECT status,attempts,last_error FROM operational_jobs WHERE id=$1",
    [deadJobId],
  );
  if(deadState.rows[0]?.status==="DEAD")break;
  await new Promise(r=>setTimeout(r,250));
}
assert(deadState.rows[0]?.status==="DEAD","malformed operational job must dead-letter");
const security=await query(
  `SELECT 1 FROM security_events
   WHERE event_type='operational_job_dead_letter'
     AND subject_id=$1`,
  [deadJobId],
);
assert(security.rowCount===1,"dead-letter must emit a security event");

// Prove an abandoned RUNNING lease is reclaimed rather than stuck forever.
const staleJob=await query(
  `INSERT INTO operational_jobs(
     workspace_id,job_type,payload,status,attempts,max_attempts,locked_at,locked_by
   ) VALUES ($1,'STORE_ARTIFACT','{}'::jsonb,'RUNNING',1,2,now()-interval '10 minutes','dead-worker')
   RETURNING id`,
  [workspaceId],
);
const staleJobId=staleJob.rows[0].id;
let staleState;
for(let i=0;i<80;i++){
  staleState=await query(
    "SELECT status,attempts,last_error,locked_by FROM operational_jobs WHERE id=$1",
    [staleJobId],
  );
  if(staleState.rows[0]?.status==="DEAD")break;
  await new Promise(r=>setTimeout(r,250));
}
assert(staleState.rows[0]?.status==="DEAD","expired RUNNING operational job must be reclaimed and dead-lettered");
assert(staleState.rows[0]?.attempts===2,"reclaimed RUNNING job must consume the next bounded attempt");
const staleSecurity=await query(
  `SELECT 1 FROM security_events
   WHERE event_type='operational_job_dead_letter'
     AND subject_id=$1`,
  [staleJobId],
);
assert(staleSecurity.rowCount===1,"expired RUNNING dead-letter must emit a security event");

// Create a second tenant/workspace and prove cross-workspace reads fail.
const target=await query(
  `SELECT t.id transformation_id,t.agent_version_id
   FROM promptforge_transformations t
   JOIN projects p ON p.id=t.project_id
   WHERE p.workspace_id=$1 AND t.agent_version_id IS NOT NULL
   ORDER BY t.created_at
   LIMIT 1`,
  [workspaceId],
);
assert(target.rows[0],"tenant A target transformation missing");

const passwordHash=await hashPassword(password);
await transaction(async(client)=>{
  const user=await client.query(
    `INSERT INTO app_users(email,display_name,password_hash)
     VALUES ($1,'Tenant B Operator',$2)
     ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name
     RETURNING id`,
    [email,passwordHash],
  );
  const ws=await client.query(
    `INSERT INTO workspaces(slug,name)
     VALUES ('phase7-tenant-b','Phase 7 Tenant B')
     ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name
     RETURNING id`,
  );
  await client.query(
    `INSERT INTO workspace_memberships(workspace_id,user_id,role)
     VALUES ($1,$2,'OWNER')
     ON CONFLICT (workspace_id,user_id) DO NOTHING`,
    [ws.rows[0].id,user.rows[0].id],
  );
  await client.query(
    `INSERT INTO projects(workspace_id,slug,name)
     VALUES ($1,'default','Default')
     ON CONFLICT (workspace_id,slug) DO NOTHING`,
    [ws.rows[0].id],
  );
});

const login=await apiCall("/v1/auth/login",{method:"POST",body:JSON.stringify({email,password})});
assert(login.response.status===200,"tenant B login failed");
const token=login.body.token;

const crossTransform=await apiCall("/v1/transformations/"+target.rows[0].transformation_id,{},token);
assert(crossTransform.response.status===404,"cross-workspace transformation read must be hidden");

const crossAuthority=await apiCall("/v1/agent-versions/"+target.rows[0].agent_version_id+"/authority-state",{},token);
assert(crossAuthority.response.status===403,"cross-workspace authority read must be forbidden");

// Health/metrics evidence.
const ready=await fetch(api+"/ready");
assert(ready.ok,"API readiness must pass");
const metrics=await fetch(api+"/metrics").then(r=>r.text());
assert(metrics.includes("agent_foundry_operational_jobs"),"operational metrics missing");
assert(metrics.includes("agent_foundry_worker_heartbeat_age_seconds"),"heartbeat metric missing");

console.log(JSON.stringify({
  status:"PASS",
  durableArtifacts:artifacts.rows.map(x=>({kind:x.kind,key:x.object_key,sha256:x.sha256})),
  deadLetter:{jobId:deadJobId,attempts:deadState.rows[0].attempts},
  tenantIsolation:{transformationStatus:crossTransform.response.status,authorityStatus:crossAuthority.response.status},
  readiness:"PASS",
  metrics:"PASS"
},null,2));

await closeDatabase();
