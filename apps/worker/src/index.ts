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

const pollMs = Number(process.env.WORKER_POLL_MS ?? 1000);
const engine = new PromptForgeEngine(createPromptForgeProviderFromEnvironment());

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

console.log(`agent-foundry-worker started; poll=${pollMs}ms provider=${process.env.PROMPTFORGE_PROVIDER ?? "deterministic"}`);

while (true) {
  const item = await claim();
  if (item) {
    await processOne(item);
    continue;
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
