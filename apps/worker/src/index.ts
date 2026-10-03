import { query, transaction } from "@agent-foundry/db";
import {
  buildReviewCandidate,
  slugify,
  type CandidateRequest,
  type RightsStatus,
} from "@agent-foundry/domain";

const pollMs = Number(process.env.WORKER_POLL_MS ?? 1000);

type Claimed = {
  id: string;
  project_id: string;
  source_artifact_id: string;
  requested_name: string;
  requested_class: CandidateRequest["agentClass"];
  created_by_user_id: string;
  content_text: string;
  rights_status: RightsStatus;
};

async function claim(): Promise<Claimed | null> {
  return transaction(async (client) => {
    const claimed = await client.query<{
      id: string; project_id: string; source_artifact_id: string;
      requested_name: string; requested_class: CandidateRequest["agentClass"];
      created_by_user_id: string;
    }>(
      `WITH next AS (
         SELECT id FROM promptforge_transformations
         WHERE status='QUEUED'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE promptforge_transformations t
       SET status='PROCESSING', started_at=now()
       FROM next
       WHERE t.id=next.id
       RETURNING t.id,t.project_id,t.source_artifact_id,t.requested_name,t.requested_class,t.created_by_user_id`,
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
    const built = buildReviewCandidate({
      name: item.requested_name,
      agentClass: item.requested_class,
      sourcePrompt: item.content_text,
      rightsStatus: item.rights_status,
    });

    await transaction(async (client) => {
      const seq = await client.query<{ value: string }>("SELECT nextval('agent_registry_seq')::text AS value");
      const suffix = seq.rows[0]!.value;
      const registryId = `AGR-${suffix}`;
      const slug = `${slugify(item.requested_name)}-${suffix}`;

      const agent = await client.query<{ id: string }>(
        `INSERT INTO agents(registry_id,slug,name,class,category)
         VALUES ($1,$2,$3,$4,'candidate') RETURNING id`,
        [registryId, slug, item.requested_name, item.requested_class],
      );
      const agentId = agent.rows[0]!.id;

      const version = await client.query<{ id: string }>(
        `INSERT INTO agent_versions(agent_id,version,status,aps_version)
         VALUES ($1,'0.1.0','DRAFT','1.5-alpha') RETURNING id`,
        [agentId],
      );
      const versionId = version.rows[0]!.id;

      await client.query(
        `INSERT INTO aps_specifications(agent_version_id,document,sha256)
         VALUES ($1,$2::jsonb,$3)`,
        [versionId, JSON.stringify(built.apsDocument), built.candidateSha256],
      );

      await client.query(
        `INSERT INTO provenance_records(agent_version_id,source_artifact_id,relation,transformation)
         VALUES ($1,$2,'TRANSFORMED_FROM',$3::jsonb)`,
        [versionId, item.source_artifact_id, JSON.stringify(built.transformationRecord)],
      );

      await client.query(
        `UPDATE promptforge_transformations
         SET agent_version_id=$1,status='REQUIRES_REVIEW',record=$2::jsonb,
             candidate_sha256=$3,completed_at=now()
         WHERE id=$4 AND status='PROCESSING'`,
        [versionId, JSON.stringify(built.transformationRecord), built.candidateSha256, item.id],
      );

      await client.query(
        `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
         VALUES ($1,'candidate_generated','agent_version',$2,$3::jsonb)`,
        [
          item.created_by_user_id,
          versionId,
          JSON.stringify({
            transformationId: item.id,
            registryId,
            sourceSha256: built.sourceSha256,
            candidateSha256: built.candidateSha256,
          }),
        ],
      );
    });

    console.log(`processed transformation ${item.id}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`transformation ${item.id} failed`, error);
    await query(
      `UPDATE promptforge_transformations
       SET status='FAILED',failure_reason=$1,completed_at=now()
       WHERE id=$2`,
      [reason.slice(0, 1000), item.id],
    );
  }
}

console.log(`agent-foundry-worker started; poll=${pollMs}ms`);

while (true) {
  const item = await claim();
  if (item) {
    await processOne(item);
    continue;
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
