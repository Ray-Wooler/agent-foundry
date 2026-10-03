import { query, transaction } from "@agent-foundry/db";
import {
  slugify,
  type CandidateRequest,
  type RightsStatus,
  canonicalJson,
  sha256Text,
} from "@agent-foundry/domain";
import {
  PromptForgeEngine,
  createPromptForgeProviderFromEnvironment,
} from "@agent-foundry/promptforge";
import {
  executeEvaluationSuite,
  aggregateRequiredSuites,
  type EvaluationSuite,
  type EvaluationOutcome,
} from "@agent-foundry/evaluation";
import { ArtifactStore, storageConfigFromEnvironment } from "@agent-foundry/storage";
import { randomUUID } from "node:crypto";

const pollMs = Number(process.env.WORKER_POLL_MS ?? 1000);
const engine = new PromptForgeEngine(createPromptForgeProviderFromEnvironment());
const workerId=process.env.WORKER_ID??`worker-${randomUUID()}`;
let artifactStore:ArtifactStore|null=null;

function getArtifactStore() {
  if(!artifactStore) artifactStore=new ArtifactStore(storageConfigFromEnvironment());
  return artifactStore;
}

type Claimed = {
  id: string;
  project_id: string;
  source_artifact_id: string;
  requested_name: string;
  requested_class: CandidateRequest["agentClass"];
  created_by_user_id: string;
  content_text: string;
  rights_status: RightsStatus;
  configuration: Record<string, unknown>;
};

async function claim(): Promise<Claimed | null> {
  return transaction(async (client) => {
    const claimed = await client.query<{
      id: string; project_id: string; source_artifact_id: string;
      requested_name: string; requested_class: CandidateRequest["agentClass"];
      created_by_user_id: string; configuration: Record<string, unknown>;
    }>(
      `WITH next AS (
         SELECT id FROM promptforge_transformations
         WHERE status='QUEUED'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE promptforge_transformations t
       SET status='PROCESSING', started_at=now(), failure_reason=NULL
       FROM next
       WHERE t.id=next.id
       RETURNING t.id,t.project_id,t.source_artifact_id,t.requested_name,t.requested_class,t.created_by_user_id,t.configuration`,
    );
    const row = claimed.rows[0];
    if (!row) return null;

    const source = await client.query<{ content_text: string; rights_status: RightsStatus }>(
      "SELECT content_text,rights_status FROM source_artifacts WHERE id=$1",
      [row.source_artifact_id],
    );
    const item = source.rows[0];
    if (!item?.content_text) throw new Error("queued transformation source content missing");
    return { ...row, content_text: item.content_text, rights_status: item.rights_status };
  });
}

async function processOne(item: Claimed) {
  try {
    const built = await engine.transform({
      name: item.requested_name,
      agentClass: item.requested_class,
      sourcePrompt: item.content_text,
      rightsStatus: item.rights_status,
      revisionRequest: typeof item.configuration.revisionRequest === "string"
        ? item.configuration.revisionRequest
        : undefined,
    }, async (stage) => {
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO promptforge_model_calls(
             transformation_id,stage,provider,model,request_id,prompt_sha256,response_sha256,output
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            item.id,
            stage.stage,
            stage.metadata.provider,
            stage.metadata.model,
            stage.metadata.requestId ?? null,
            stage.metadata.promptSha256,
            stage.metadata.responseSha256,
            JSON.stringify(stage.output),
          ],
        );

        await client.query(
          `INSERT INTO promptforge_stage_results(
             transformation_id,stage,status,output,sha256
           ) VALUES ($1,$2,'PASS',$3::jsonb,$4)`,
          [
            item.id,
            stage.stage,
            JSON.stringify(stage.output),
            sha256Text(canonicalJson(stage.output)),
          ],
        );
      });
    });

    await transaction(async (client) => {
      const parentAgentVersionId = typeof item.configuration.parentAgentVersionId === "string"
        ? item.configuration.parentAgentVersionId
        : null;

      let agentId: string;
      let registryId: string;
      let versionLabel: string;

      if (parentAgentVersionId) {
        const parent = await client.query<{ agent_id: string; registry_id: string }>(
          `SELECT av.agent_id,a.registry_id
           FROM agent_versions av
           JOIN agents a ON a.id=av.agent_id
           WHERE av.id=$1`,
          [parentAgentVersionId],
        );
        const parentRow = parent.rows[0];
        if (!parentRow) throw new Error("revision parent AgentVersion not found");
        agentId = parentRow.agent_id;
        registryId = parentRow.registry_id;

        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM agent_versions WHERE agent_id=$1",
          [agentId],
        );
        versionLabel = `0.1.${count.rows[0]!.count}`;
      } else {
        const seq = await client.query<{ value: string }>("SELECT nextval('agent_registry_seq')::text AS value");
        const suffix = seq.rows[0]!.value;
        registryId = `AGR-${suffix}`;
        const slug = `${slugify(item.requested_name)}-${suffix}`;

        const agent = await client.query<{ id: string }>(
          `INSERT INTO agents(registry_id,slug,name,class,category)
           VALUES ($1,$2,$3,$4,'candidate') RETURNING id`,
          [registryId, slug, item.requested_name, item.requested_class],
        );
        agentId = agent.rows[0]!.id;
        const workspace=await client.query<{workspace_id:string}>(
          "SELECT workspace_id FROM projects WHERE id=$1",
          [item.project_id],
        );
        if(!workspace.rows[0]?.workspace_id) throw new Error("workspace binding context missing");
        await client.query(
          `INSERT INTO agent_workspace_bindings(agent_id,workspace_id)
           VALUES ($1,$2)`,
          [agentId,workspace.rows[0].workspace_id],
        );
        versionLabel = "0.1.0";
      }

      const version = await client.query<{ id: string }>(
        `INSERT INTO agent_versions(agent_id,version,status,aps_version)
         VALUES ($1,$2,'DRAFT','1.5-alpha') RETURNING id`,
        [agentId, versionLabel],
      );
      const versionId = version.rows[0]!.id;

      await client.query(
        `INSERT INTO aps_specifications(agent_version_id,document,sha256)
         VALUES ($1,$2::jsonb,$3)`,
        [versionId, JSON.stringify(built.apsDocument), built.candidateSha256],
      );

      await client.query(
        `INSERT INTO promptforge_review_packages(
           transformation_id,baseline_candidate,candidate_diff,explanation,validation
         ) VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb)`,
        [
          item.id,
          JSON.stringify(built.reviewPackage.baselineCandidate),
          JSON.stringify(built.reviewPackage.candidateDiff),
          JSON.stringify(built.reviewPackage.explanation),
          JSON.stringify(built.reviewPackage.validation),
        ],
      );

      await client.query(
        `INSERT INTO provenance_records(agent_version_id,source_artifact_id,relation,transformation)
         VALUES ($1,$2,'TRANSFORMED_FROM',$3::jsonb)`,
        [versionId, item.source_artifact_id, JSON.stringify(built.transformationRecord)],
      );

      await client.query(
        `UPDATE promptforge_transformations
         SET agent_version_id=$1,status='REQUIRES_REVIEW',record=$2::jsonb,
             candidate_sha256=$3,completed_at=now(),
             provider=$4,model=$5,validation_status='PASS'
         WHERE id=$6 AND status='PROCESSING'`,
        [
          versionId,
          JSON.stringify(built.transformationRecord),
          built.candidateSha256,
          built.provider,
          built.model,
          item.id,
        ],
      );

      const parentTransformationId = typeof item.configuration.parentTransformationId === "string"
        ? item.configuration.parentTransformationId : null;
      if (parentTransformationId) {
        await client.query(
          `UPDATE candidate_revision_lineage
           SET child_agent_version_id=$1
           WHERE child_transformation_id=$2
             AND child_agent_version_id IS NULL`,
          [versionId, item.id],
        );
      }

      await client.query(
        `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
         VALUES ($1,'promptforge_model_candidate_generated','agent_version',$2,$3::jsonb)`,
        [
          item.created_by_user_id,
          versionId,
          JSON.stringify({
            transformationId: item.id,
            registryId,
            sourceSha256: built.sourceSha256,
            candidateSha256: built.candidateSha256,
            provider: built.provider,
            model: built.model,
            stageCount: built.stages.length,
            validationStatus: built.reviewPackage.validation.status,
          }),
        ],
      );
    });

    console.log(`processed model-backed transformation ${item.id}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`transformation ${item.id} failed`, error);
    await query(
      `UPDATE promptforge_transformations
       SET status='FAILED',failure_reason=$1,completed_at=now(),validation_status='FAIL'
       WHERE id=$2`,
      [reason.slice(0, 1000), item.id],
    );
  }
}


type EvaluationClaim = {
  execution_id: string;
  plan_id: string;
  evaluation_suite_id: string;
  suite_definition: EvaluationSuite;
  agent_version_id: string;
  aps_document: unknown;
  registry_id: string;
  version: string;
};

async function refreshEvaluationPlan(planId: string) {
  await transaction(async (client) => {
    const plan = await client.query<{ agent_version_id: string }>(
      "SELECT agent_version_id FROM evaluation_plans WHERE id=$1 FOR UPDATE",
      [planId],
    );
    const agentVersionId = plan.rows[0]?.agent_version_id;
    if (!agentVersionId) return;

    const rows = await client.query<{
      required: boolean; status: string; outcome: EvaluationOutcome | null;
    }>(
      `SELECT ps.required,e.status,e.outcome
       FROM evaluation_plan_suites ps
       JOIN evaluation_suite_executions e
         ON e.plan_id=ps.plan_id AND e.evaluation_suite_id=ps.evaluation_suite_id
       WHERE ps.plan_id=$1
       ORDER BY ps.ordinal`,
      [planId],
    );

    const aggregate = aggregateRequiredSuites(rows.rows);
    if (aggregate.awaitingHuman) {
      await client.query(
        "UPDATE evaluation_plans SET status='AWAITING_HUMAN' WHERE id=$1",
        [planId],
      );
      await client.query(
        `UPDATE lifecycle_readiness
         SET evaluation_status='AWAITING_HUMAN',updated_at=now()
         WHERE agent_version_id=$1`,
        [agentVersionId],
      );
      return;
    }

    if (!aggregate.complete) {
      await client.query(
        "UPDATE evaluation_plans SET status='RUNNING' WHERE id=$1",
        [planId],
      );
      await client.query(
        `UPDATE lifecycle_readiness
         SET evaluation_status='RUNNING',updated_at=now()
         WHERE agent_version_id=$1`,
        [agentVersionId],
      );
      return;
    }

    await client.query(
      `UPDATE evaluation_plans
       SET status='COMPLETED',aggregate_outcome=$1,completed_at=now()
       WHERE id=$2`,
      [aggregate.outcome, planId],
    );

    await client.query(
      `UPDATE lifecycle_readiness
       SET evaluation_status=$1,
           certification_readiness_status='NOT_REVIEWED',
           certification_status='NOT_ELIGIBLE',
           updated_at=now()
       WHERE agent_version_id=$2`,
      [aggregate.outcome === "PASS" ? "PASSED" : "FAILED", agentVersionId],
    );

    await client.query(
      `UPDATE agent_versions
       SET status='EVALUATED'
       WHERE id=$1 AND status='VALIDATED'`,
      [agentVersionId],
    );

    await client.query(
      `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
       VALUES ('system','evaluation_plan_completed','agent_version',$1,$2::jsonb)`,
      [
        agentVersionId,
        JSON.stringify({ planId, aggregateOutcome: aggregate.outcome }),
      ],
    );
  });
}

async function claimEvaluation(): Promise<EvaluationClaim | null> {
  return transaction(async (client) => {
    const claimed = await client.query<{
      id: string; plan_id: string; evaluation_suite_id: string;
    }>(
      `WITH next AS (
         SELECT e.id
         FROM evaluation_suite_executions e
         JOIN evaluation_plans p ON p.id=e.plan_id
         WHERE e.status='QUEUED'
           AND p.status IN ('READY','RUNNING')
         ORDER BY e.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE evaluation_suite_executions e
       SET status='RUNNING',started_at=now()
       FROM next
       WHERE e.id=next.id
       RETURNING e.id,e.plan_id,e.evaluation_suite_id`,
    );
    const row = claimed.rows[0];
    if (!row) return null;

    const context = await client.query<{
      suite_definition: EvaluationSuite;
      agent_version_id: string;
      aps_document: unknown;
      registry_id: string;
      version: string;
    }>(
      `SELECT s.definition suite_definition,p.agent_version_id,aps.document aps_document,
              a.registry_id,av.version
       FROM evaluation_plans p
       JOIN evaluation_suites s ON s.id=$2
       JOIN agent_versions av ON av.id=p.agent_version_id
       JOIN agents a ON a.id=av.agent_id
       JOIN aps_specifications aps ON aps.agent_version_id=av.id
       WHERE p.id=$1`,
      [row.plan_id,row.evaluation_suite_id],
    );
    const item = context.rows[0];
    if (!item) throw new Error("evaluation execution context missing");

    await client.query(
      `UPDATE evaluation_plans
       SET status='RUNNING',started_at=COALESCE(started_at,now())
       WHERE id=$1`,
      [row.plan_id],
    );
    await client.query(
      `UPDATE lifecycle_readiness
       SET evaluation_status='RUNNING',updated_at=now()
       WHERE agent_version_id=$1`,
      [item.agent_version_id],
    );

    return {
      execution_id: row.id,
      plan_id: row.plan_id,
      evaluation_suite_id: row.evaluation_suite_id,
      ...item,
    };
  });
}

async function processEvaluation(item: EvaluationClaim) {
  try {
    const result = executeEvaluationSuite(item.suite_definition, item.aps_document);

    if (result.status === "AWAITING_HUMAN") {
      await query(
        `UPDATE evaluation_suite_executions
         SET status='AWAITING_HUMAN',outcome='NOT_TESTED',machine_evidence=$1::jsonb
         WHERE id=$2`,
        [JSON.stringify(result.results),item.execution_id],
      );
      await refreshEvaluationPlan(item.plan_id);
      console.log(`evaluation execution ${item.execution_id} awaiting human review`);
      return;
    }

    await transaction(async (client) => {
      const run = await client.query<{ id: string }>(
        `INSERT INTO evaluation_runs(
           agent_version_id,evaluation_suite_id,outcome,evidence,started_at,completed_at
         ) VALUES ($1,$2,$3,$4::jsonb,now(),now())
         RETURNING id`,
        [
          item.agent_version_id,
          item.evaluation_suite_id,
          result.outcome,
          JSON.stringify({
            runtime:{target:"foundry-evaluator",identity:"evaluation-worker"},
            results:result.results,
          }),
        ],
      );

      for (const assertion of result.results) {
        await client.query(
          `INSERT INTO evaluation_results(
             evaluation_run_id,case_key,outcome,evidence
           ) VALUES ($1,$2,$3,$4::jsonb)`,
          [
            run.rows[0]!.id,
            `${assertion.case_id}:${assertion.assertion_id}`,
            assertion.outcome,
            JSON.stringify({
              assertionType:assertion.assertion_type,
              required:assertion.required,
              evidence:assertion.evidence,
              reviewer:assertion.reviewer,
            }),
          ],
        );
      }

      await client.query(
        `UPDATE evaluation_suite_executions
         SET status='COMPLETED',outcome=$1,evaluation_run_id=$2,
             machine_evidence=$3::jsonb,completed_at=now()
         WHERE id=$4`,
        [result.outcome,run.rows[0]!.id,JSON.stringify(result.results),item.execution_id],
      );

      await client.query(
        `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
         VALUES ('system','evaluation_suite_completed','evaluation_run',$1,$2::jsonb)`,
        [
          run.rows[0]!.id,
          JSON.stringify({
            planId:item.plan_id,
            suiteId:item.suite_definition.suite_id,
            outcome:result.outcome,
          }),
        ],
      );
    });

    await refreshEvaluationPlan(item.plan_id);
    console.log(`completed evaluation execution ${item.execution_id}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`evaluation execution ${item.execution_id} failed`, error);
    await query(
      `UPDATE evaluation_suite_executions
       SET status='FAILED',outcome='FAIL',machine_evidence=$1::jsonb,completed_at=now()
       WHERE id=$2`,
      [JSON.stringify([{error:reason.slice(0,1000)}]),item.execution_id],
    );
    await query(
      "UPDATE evaluation_plans SET status='FAILED',aggregate_outcome='FAIL',completed_at=now() WHERE id=$1",
      [item.plan_id],
    );
    await query(
      `UPDATE lifecycle_readiness
       SET evaluation_status='FAILED',updated_at=now()
       WHERE agent_version_id=$1`,
      [item.agent_version_id],
    );
  }
}


type OperationalJob={
  id:string;
  workspace_id:string|null;
  job_type:"STORE_ARTIFACT"|"VERIFY_ARTIFACT"|"BACKUP_VERIFY";
  payload:Record<string,unknown>;
  attempts:number;
  max_attempts:number;
};

async function heartbeat() {
  await query(
    `INSERT INTO worker_heartbeats(worker_id,process_type,version,metadata,last_seen_at)
     VALUES ($1,'worker',$2,$3::jsonb,now())
     ON CONFLICT (worker_id) DO UPDATE
     SET version=EXCLUDED.version,metadata=EXCLUDED.metadata,last_seen_at=now()`,
    [workerId,process.env.APP_VERSION??"dev",JSON.stringify({hostname:process.env.HOSTNAME??null})],
  );
}

async function claimOperationalJob():Promise<OperationalJob|null> {
  return transaction(async(client)=>{
    const result=await client.query<OperationalJob>(
      `WITH next AS (
         SELECT id FROM operational_jobs
         WHERE status IN ('QUEUED','RETRY')
           AND available_at<=now()
         ORDER BY available_at,created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE operational_jobs j
       SET status='RUNNING',locked_at=now(),locked_by=$1,attempts=j.attempts+1
       FROM next
       WHERE j.id=next.id
       RETURNING j.id,j.workspace_id,j.job_type,j.payload,j.attempts,j.max_attempts`,
      [workerId],
    );
    return result.rows[0]??null;
  });
}

async function finishOperationalJob(job:OperationalJob) {
  await query(
    `UPDATE operational_jobs
     SET status='COMPLETED',completed_at=now(),locked_at=NULL,locked_by=NULL,last_error=NULL
     WHERE id=$1`,
    [job.id],
  );
}

async function failOperationalJob(job:OperationalJob,error:unknown) {
  const reason=error instanceof Error?error.message:String(error);
  const dead=job.attempts>=job.max_attempts;
  const delaySeconds=Math.min(300,Math.max(5,2**Math.min(job.attempts,8)));
  await transaction(async(client)=>{
    await client.query(
      `UPDATE operational_jobs
       SET status=$1,last_error=$2,available_at=CASE WHEN $1='RETRY' THEN now()+($3::text||' seconds')::interval ELSE available_at END,
           locked_at=NULL,locked_by=NULL
       WHERE id=$4`,
      [dead?"DEAD":"RETRY",reason.slice(0,2000),String(delaySeconds),job.id],
    );
    if(dead) {
      await client.query(
        `INSERT INTO security_events(workspace_id,event_type,severity,subject_type,subject_id,evidence)
         VALUES ($1,'operational_job_dead_letter','HIGH','operational_job',$2,$3::jsonb)`,
        [job.workspace_id,job.id,JSON.stringify({jobType:job.job_type,error:reason.slice(0,1000),attempts:job.attempts})],
      );
    }
  });
}

async function processOperationalJob(job:OperationalJob) {
  try {
    if(job.job_type==="STORE_ARTIFACT") {
      const artifactObjectId=String(job.payload.artifactObjectId??"");
      const objectKey=String(job.payload.objectKey??"");
      const expectedSha256=String(job.payload.expectedSha256??"");
      const content=job.payload.content;
      if(!artifactObjectId||!objectKey||!expectedSha256) throw new Error("STORE_ARTIFACT payload incomplete");

      const stored=await getArtifactStore().putJson(objectKey,content,expectedSha256);
      const verified=await getArtifactStore().verify(objectKey,expectedSha256);
      await query(
        `UPDATE artifact_objects
         SET storage_status='STORED',attempts=attempts+1,last_error=NULL,stored_at=now()
         WHERE id=$1`,
        [artifactObjectId],
      );
      await query(
        `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
         VALUES ('system','artifact_stored','artifact_object',$1,$2::jsonb)`,
        [artifactObjectId,JSON.stringify({objectKey,sha256:stored.sha256,byteSize:verified.byteSize,workerId})],
      );
      await finishOperationalJob(job);
      return;
    }

    if(job.job_type==="VERIFY_ARTIFACT") {
      const artifactObjectId=String(job.payload.artifactObjectId??"");
      const row=await query<{object_key:string;sha256:string}>(
        "SELECT object_key,sha256 FROM artifact_objects WHERE id=$1",
        [artifactObjectId],
      );
      const artifact=row.rows[0];
      if(!artifact) throw new Error("artifact not found");
      await getArtifactStore().verify(artifact.object_key,artifact.sha256);
      await finishOperationalJob(job);
      return;
    }

    if(job.job_type==="BACKUP_VERIFY") {
      await finishOperationalJob(job);
      return;
    }

    throw new Error(`unsupported operational job type ${job.job_type}`);
  } catch(error) {
    await failOperationalJob(job,error);
  }
}

console.log(`agent-foundry-worker started; poll=${pollMs}ms provider=${process.env.PROMPTFORGE_PROVIDER ?? "deterministic"}`);

let lastHeartbeat=0;
while (true) {
  if(Date.now()-lastHeartbeat>15000) {
    await heartbeat().catch((error)=>console.error("worker heartbeat failed",error));
    lastHeartbeat=Date.now();
  }

  const operational=await claimOperationalJob();
  if(operational) {
    await processOperationalJob(operational);
    continue;
  }

  const evaluation = await claimEvaluation();
  if (evaluation) {
    await processEvaluation(evaluation);
    continue;
  }

  const item = await claim();
  if (item) {
    await processOne(item);
    continue;
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
