import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { digestSessionToken, issueSessionToken, normalizeEmail, verifyPassword } from "@agent-foundry/auth";
import { query, transaction } from "@agent-foundry/db";
import { canonicalJson, sha256Text, type RightsStatus } from "@agent-foundry/domain";
import { assertSafeObjectKeySegment } from "@agent-foundry/storage";
import {
  buildReleaseBundle,
  buildPublicationPayload,
  buildFrankAIRegistrationPayload,
} from "@agent-foundry/release";
import {
  applyHumanReview,
  aggregateRequiredSuites,
  type AssertionResult,
  type EvaluationOutcome,
} from "@agent-foundry/evaluation";
import { bootstrapIdentity } from "./bootstrap.js";

type SessionUser = { id: string; email: string; display_name: string };
type MembershipRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";

const port = Number(process.env.API_PORT ?? 3001);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const sessionTtlHours = Number(process.env.SESSION_TTL_HOURS ?? 24);

const agentClasses = new Set([
  "orchestrator","specialist","builder","analyst","advisor","monitor","communicator","reviewer",
]);
const rightsStatuses = new Set<RightsStatus>(["VERIFIED","UNVERIFIED","RESTRICTED","PROHIBITED"]);

function textResponse(res: ServerResponse,status:number,body:string,contentType="text/plain; charset=utf-8"){
  res.writeHead(status,{"content-type":contentType,"content-length":Buffer.byteLength(body)});
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": webOrigin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "vary": "origin",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function bearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

async function authenticate(req: IncomingMessage): Promise<SessionUser | null> {
  const token = bearer(req);
  if (!token) return null;
  const digest = digestSessionToken(token);
  const result = await query<SessionUser>(
    `SELECT u.id,u.email,u.display_name
     FROM auth_sessions s
     JOIN app_users u ON u.id=s.user_id
     WHERE s.token_sha256=$1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.disabled_at IS NULL`,
    [digest],
  );
  return result.rows[0] ?? null;
}

async function memberships(userId: string) {
  const result = await query<{
    workspace_id: string;
    workspace_name: string;
    workspace_slug: string;
    role: MembershipRole;
    project_id: string | null;
    project_name: string | null;
    project_slug: string | null;
  }>(
    `SELECT w.id workspace_id,w.name workspace_name,w.slug workspace_slug,m.role,
            p.id project_id,p.name project_name,p.slug project_slug
     FROM workspace_memberships m
     JOIN workspaces w ON w.id=m.workspace_id
     LEFT JOIN projects p ON p.workspace_id=w.id
     WHERE m.user_id=$1
     ORDER BY w.name,p.name`,
    [userId],
  );
  const map = new Map<string, {
    id: string; name: string; slug: string; role: MembershipRole;
    projects: { id: string; name: string; slug: string }[];
  }>();
  for (const row of result.rows) {
    let item = map.get(row.workspace_id);
    if (!item) {
      item = {
        id: row.workspace_id,
        name: row.workspace_name,
        slug: row.workspace_slug,
        role: row.role,
        projects: [],
      };
      map.set(row.workspace_id, item);
    }
    if (row.project_id && row.project_name && row.project_slug) {
      item.projects.push({ id: row.project_id, name: row.project_name, slug: row.project_slug });
    }
  }
  return [...map.values()];
}

async function canEditProject(userId: string, projectId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1
     FROM projects p
     JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
     WHERE p.id=$1 AND m.user_id=$2 AND m.role IN ('OWNER','ADMIN','EDITOR')`,
    [projectId, userId],
  );
  return Boolean(result.rowCount);
}

async function reviewerRoleForTransformation(
  userId: string,
  transformationId: string,
): Promise<Exclude<MembershipRole,"VIEWER"> | null> {
  const result = await query<{ role: Exclude<MembershipRole,"VIEWER"> }>(
    `SELECT m.role
     FROM promptforge_transformations t
     JOIN projects p ON p.id=t.project_id
     JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
     WHERE t.id=$1 AND m.user_id=$2 AND m.role IN ('OWNER','ADMIN','EDITOR')`,
    [transformationId, userId],
  );
  return result.rows[0]?.role ?? null;
}


async function reviewerRoleForEvaluationPlan(
  userId: string,
  planId: string,
): Promise<Exclude<MembershipRole,"VIEWER"> | null> {
  const result = await query<{ role: Exclude<MembershipRole,"VIEWER"> }>(
    `SELECT m.role
     FROM evaluation_plans ep
     JOIN promptforge_transformations t ON t.agent_version_id=ep.agent_version_id
     JOIN projects p ON p.id=t.project_id
     JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
     WHERE ep.id=$1 AND m.user_id=$2 AND m.role IN ('OWNER','ADMIN','EDITOR')
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [planId,userId],
  );
  return result.rows[0]?.role ?? null;
}

async function reviewerRoleForEvaluationExecution(
  userId: string,
  executionId: string,
): Promise<Exclude<MembershipRole,"VIEWER"> | null> {
  const result = await query<{ role: Exclude<MembershipRole,"VIEWER"> }>(
    `SELECT m.role
     FROM evaluation_suite_executions e
     JOIN evaluation_plans ep ON ep.id=e.plan_id
     JOIN promptforge_transformations t ON t.agent_version_id=ep.agent_version_id
     JOIN projects p ON p.id=t.project_id
     JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
     WHERE e.id=$1 AND m.user_id=$2 AND m.role IN ('OWNER','ADMIN','EDITOR')
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [executionId,userId],
  );
  return result.rows[0]?.role ?? null;
}

async function refreshEvaluationPlanClient(client: any, planId: string) {
  const plan = await client.query(
    "SELECT agent_version_id FROM evaluation_plans WHERE id=$1 FOR UPDATE",
    [planId],
  );
  const agentVersionId = plan.rows[0]?.agent_version_id as string | undefined;
  if (!agentVersionId) throw new Error("evaluation_plan_not_found");

  const rows = await client.query(
    `SELECT ps.required,e.status,e.outcome
     FROM evaluation_plan_suites ps
     JOIN evaluation_suite_executions e
       ON e.plan_id=ps.plan_id AND e.evaluation_suite_id=ps.evaluation_suite_id
     WHERE ps.plan_id=$1
     ORDER BY ps.ordinal`,
    [planId],
  );

  const aggregate = aggregateRequiredSuites(rows.rows as Array<{
    required:boolean; status:string; outcome:EvaluationOutcome|null;
  }>);

  if (aggregate.awaitingHuman) {
    await client.query("UPDATE evaluation_plans SET status='AWAITING_HUMAN' WHERE id=$1",[planId]);
    await client.query(
      `UPDATE lifecycle_readiness
       SET evaluation_status='AWAITING_HUMAN',updated_at=now()
       WHERE agent_version_id=$1`,
      [agentVersionId],
    );
    return { status:"AWAITING_HUMAN", aggregateOutcome:null };
  }

  if (!aggregate.complete) {
    await client.query("UPDATE evaluation_plans SET status='RUNNING' WHERE id=$1",[planId]);
    await client.query(
      `UPDATE lifecycle_readiness
       SET evaluation_status='RUNNING',updated_at=now()
       WHERE agent_version_id=$1`,
      [agentVersionId],
    );
    return { status:"RUNNING", aggregateOutcome:null };
  }

  await client.query(
    `UPDATE evaluation_plans
     SET status='COMPLETED',aggregate_outcome=$1,completed_at=now()
     WHERE id=$2`,
    [aggregate.outcome,planId],
  );
  await client.query(
    `UPDATE lifecycle_readiness
     SET evaluation_status=$1,certification_readiness_status='NOT_REVIEWED',
         certification_status='NOT_ELIGIBLE',updated_at=now()
     WHERE agent_version_id=$2`,
    [aggregate.outcome==="PASS"?"PASSED":"FAILED",agentVersionId],
  );
  await client.query(
    "UPDATE agent_versions SET status='EVALUATED' WHERE id=$1 AND status='VALIDATED'",
    [agentVersionId],
  );
  return { status:"COMPLETED", aggregateOutcome:aggregate.outcome };
}


async function authorityRoleForAgentVersion(
  userId: string,
  agentVersionId: string,
): Promise<"OWNER" | "ADMIN" | null> {
  const result = await query<{ role: "OWNER" | "ADMIN" }>(
    `SELECT m.role
     FROM promptforge_transformations t
     JOIN projects p ON p.id=t.project_id
     JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
     WHERE t.agent_version_id=$1
       AND m.user_id=$2
       AND m.role IN ('OWNER','ADMIN')
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [agentVersionId,userId],
  );
  return result.rows[0]?.role ?? null;
}


async function authorityRoleForReleasePackage(
  userId: string,
  packageRecordId: string,
): Promise<"OWNER" | "ADMIN" | null> {
  const result = await query<{ role: "OWNER" | "ADMIN" }>(
    `SELECT m.role
     FROM release_package_records rp
     JOIN promptforge_transformations t ON t.agent_version_id=rp.agent_version_id
     JOIN projects p ON p.id=t.project_id
     JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
     WHERE rp.id=$1 AND m.user_id=$2 AND m.role IN ('OWNER','ADMIN')
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [packageRecordId,userId],
  );
  return result.rows[0]?.role ?? null;
}

async function authorityRoleForPublication(
  userId: string,
  publicationId: string,
): Promise<"OWNER" | "ADMIN" | null> {
  const result = await query<{ role: "OWNER" | "ADMIN" }>(
    `SELECT m.role
     FROM publication_records pub
     JOIN release_package_records rp ON rp.id=pub.release_package_record_id
     JOIN promptforge_transformations t ON t.agent_version_id=rp.agent_version_id
     JOIN projects p ON p.id=t.project_id
     JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
     WHERE pub.id=$1 AND m.user_id=$2 AND m.role IN ('OWNER','ADMIN')
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [publicationId,userId],
  );
  return result.rows[0]?.role ?? null;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const db = await query<{ now: string }>("SELECT now()::text AS now");
    return json(res, 200, { status: "ok", service: "agent-foundry-api", database: db.rows[0]?.now });
  }

  if (req.method === "GET" && url.pathname === "/ready") {
    try {
      const db=await query<{migration_count:string}>(
        "SELECT count(*)::text migration_count FROM app_schema_migrations"
      );
      return json(res,200,{
        status:"ready",
        service:"agent-foundry-api",
        version:process.env.APP_VERSION??"dev",
        migrations:Number(db.rows[0]?.migration_count??0),
      });
    } catch(error) {
      return json(res,503,{status:"not_ready",error:error instanceof Error?error.message:String(error)});
    }
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    const jobs=await query<{status:string;count:string}>(
      "SELECT status,count(*)::text count FROM operational_jobs GROUP BY status"
    );
    const artifacts=await query<{storage_status:string;count:string}>(
      "SELECT storage_status,count(*)::text count FROM artifact_objects GROUP BY storage_status"
    );
    const heartbeat=await query<{age_seconds:string|null}>(
      "SELECT extract(epoch from (now()-max(last_seen_at)))::text age_seconds FROM worker_heartbeats"
    );
    const security=await query<{severity:string;count:string}>(
      "SELECT severity,count(*)::text count FROM security_events GROUP BY severity"
    );
    const lines=[
      "# HELP agent_foundry_operational_jobs Operational job counts by status",
      "# TYPE agent_foundry_operational_jobs gauge",
      ...jobs.rows.map(r=>`agent_foundry_operational_jobs{status="${r.status}"} ${r.count}`),
      "# HELP agent_foundry_artifacts Artifact counts by durability status",
      "# TYPE agent_foundry_artifacts gauge",
      ...artifacts.rows.map(r=>`agent_foundry_artifacts{status="${r.storage_status}"} ${r.count}`),
      "# HELP agent_foundry_worker_heartbeat_age_seconds Age of the latest worker heartbeat",
      "# TYPE agent_foundry_worker_heartbeat_age_seconds gauge",
      `agent_foundry_worker_heartbeat_age_seconds ${heartbeat.rows[0]?.age_seconds??"-1"}`,
      "# HELP agent_foundry_security_events Security events by severity",
      "# TYPE agent_foundry_security_events gauge",
      ...security.rows.map(r=>`agent_foundry_security_events{severity="${r.severity}"} ${r.count}`),
      "",
    ];
    return textResponse(res,200,lines.join("\n"),"text/plain; version=0.0.4; charset=utf-8");
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/login") {
    const body = await readJson(req);
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    const password = typeof body.password === "string" ? body.password : "";
    const found = await query<SessionUser & { password_hash: string }>(
      "SELECT id,email,display_name,password_hash FROM app_users WHERE email=$1 AND disabled_at IS NULL",
      [email],
    );
    const user = found.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return json(res, 401, { error: "invalid_credentials" });
    }
    const { token, tokenSha256 } = issueSessionToken();
    await query(
      `INSERT INTO auth_sessions(user_id,token_sha256,expires_at)
       VALUES ($1,$2,now()+($3::text || ' hours')::interval)`,
      [user.id, tokenSha256, String(sessionTtlHours)],
    );
    return json(res, 200, {
      token,
      user: { id: user.id, email: user.email, displayName: user.display_name },
      workspaces: await memberships(user.id),
    });
  }

  const user = await authenticate(req);
  if (!user) return json(res, 401, { error: "unauthorized" });

  if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
    const token = bearer(req)!;
    await query("UPDATE auth_sessions SET revoked_at=now() WHERE token_sha256=$1", [digestSessionToken(token)]);
    return json(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && url.pathname === "/v1/me") {
    return json(res, 200, {
      user: { id: user.id, email: user.email, displayName: user.display_name },
      workspaces: await memberships(user.id),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/workspaces") {
    return json(res, 200, { workspaces: await memberships(user.id) });
  }

  if (req.method === "POST" && url.pathname === "/v1/intake") {
    const body = await readJson(req);
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const sourcePrompt = typeof body.sourcePrompt === "string" ? body.sourcePrompt : "";
    const agentClass = typeof body.agentClass === "string" ? body.agentClass : "specialist";
    const rightsStatus = typeof body.rightsStatus === "string" ? body.rightsStatus as RightsStatus : "UNVERIFIED";

    if (!projectId || !name || !sourcePrompt.trim()) return json(res, 400, { error: "missing_required_fields" });
    if (name.length > 120 || sourcePrompt.length > 250_000) return json(res, 400, { error: "input_limits_exceeded" });
    if (!agentClasses.has(agentClass) || !rightsStatuses.has(rightsStatus)) return json(res, 400, { error: "invalid_class_or_rights" });
    if (!(await canEditProject(user.id, projectId))) return json(res, 403, { error: "insufficient_workspace_role" });

    const sourceSha256 = sha256Text(sourcePrompt);
    const result = await transaction(async (client) => {
      const source = await client.query<{ id: string }>(
        `INSERT INTO source_artifacts(
          source_type,title,sha256,rights_status,project_id,created_by_user_id,content_text,media_type
        ) VALUES ('PROMPT',$1,$2,$3,$4,$5,$6,'text/plain') RETURNING id`,
        [name, sourceSha256, rightsStatus, projectId, user.id, sourcePrompt],
      );
      const sourceId = source.rows[0]!.id;

      const transformation = await client.query<{ id: string }>(
        `INSERT INTO promptforge_transformations(
          project_id,source_artifact_id,requested_name,requested_class,status,
          configuration,source_sha256,created_by_user_id
        ) VALUES ($1,$2,$3,$4,'QUEUED',$5::jsonb,$6,$7)
        RETURNING id`,
        [
          projectId,
          sourceId,
          name,
          agentClass,
          JSON.stringify({ rightsStatus, apsVersion: "1.5-alpha" }),
          sourceSha256,
          user.id,
        ],
      );

      await client.query(
        `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
         VALUES ($1,'prompt_intake_queued','promptforge_transformation',$2,$3::jsonb)`,
        [user.id, transformation.rows[0]!.id, JSON.stringify({ sourceSha256, projectId })],
      );
      return { transformationId: transformation.rows[0]!.id, sourceId };
    });

    return json(res, 202, { ...result, status: "QUEUED", sourceSha256 });
  }

  const reviewMatch = /^\/v1\/transformations\/([0-9a-f-]+)\/review$/.exec(url.pathname);
  if (req.method === "POST" && reviewMatch) {
    const transformationId = reviewMatch[1]!;
    const role = await reviewerRoleForTransformation(user.id, transformationId);
    if (!role) return json(res, 403, { error: "insufficient_workspace_role" });

    const body = await readJson(req);
    const decision = typeof body.decision === "string" ? body.decision : "";
    const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
    const requestedChanges = typeof body.requestedChanges === "string" ? body.requestedChanges.trim() : null;
    if (!["APPROVE","REJECT","REQUEST_CHANGES"].includes(decision)) {
      return json(res, 400, { error: "invalid_review_decision" });
    }
    if (rationale.length < 3) return json(res, 400, { error: "review_rationale_required" });
    if (decision === "REQUEST_CHANGES" && !requestedChanges) {
      return json(res, 400, { error: "requested_changes_required" });
    }

    try {
      const result = await transaction(async (client) => {
        const existingReview = await client.query(
          "SELECT 1 FROM semantic_reviews WHERE transformation_id=$1",
          [transformationId],
        );
        if (existingReview.rowCount) throw new Error("review_already_recorded");

        const candidate = await client.query<{
          agent_version_id: string; candidate_sha256: string; status: string;
        }>(
          `SELECT agent_version_id,candidate_sha256,status
           FROM promptforge_transformations
           WHERE id=$1
           FOR UPDATE`,
          [transformationId],
        );
        const item = candidate.rows[0];
        if (!item?.agent_version_id || !item.candidate_sha256) throw new Error("candidate_not_ready");
        if (item.status !== "REQUIRES_REVIEW") throw new Error("candidate_not_reviewable");

        const review = await client.query<{ id: string; created_at: string }>(
          `INSERT INTO semantic_reviews(
             transformation_id,agent_version_id,candidate_sha256,
             reviewer_user_id,reviewer_role,decision,rationale,requested_changes
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,created_at::text`,
          [
            transformationId,item.agent_version_id,item.candidate_sha256,
            user.id,role,decision,rationale,
            decision === "REQUEST_CHANGES" ? requestedChanges : null,
          ],
        );

        const semanticStatus = decision === "APPROVE"
          ? "APPROVED" : decision === "REJECT" ? "REJECTED" : "CHANGES_REQUESTED";
        const evalReady = decision === "APPROVE" ? "READY" : "NOT_READY";

        await client.query(
          `UPDATE lifecycle_readiness
           SET semantic_approval_status=$1,evaluation_readiness_status=$2,
               certification_status='NOT_ELIGIBLE',release_status='NOT_ELIGIBLE',updated_at=now()
           WHERE agent_version_id=$3`,
          [semanticStatus,evalReady,item.agent_version_id],
        );

        if (decision === "APPROVE") {
          await client.query(
            `UPDATE agent_versions
             SET content_sha256=$1,status='CANDIDATE',promoted_at=now()
             WHERE id=$2 AND status='DRAFT'`,
            [item.candidate_sha256,item.agent_version_id],
          );
        }

        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,authority_reference,evidence)
           VALUES ($1,$2,'agent_version',$3,$4,$5::jsonb)`,
          [
            user.id,
            decision === "APPROVE" ? "semantic_review_approved"
              : decision === "REJECT" ? "semantic_review_rejected"
              : "semantic_review_changes_requested",
            item.agent_version_id,review.rows[0]!.id,
            JSON.stringify({transformationId,candidateSha256:item.candidate_sha256,reviewerRole:role}),
          ],
        );

        return {
          reviewId: review.rows[0]!.id,
          reviewedAt: review.rows[0]!.created_at,
          agentVersionId: item.agent_version_id,
          semanticApprovalStatus: semanticStatus,
          evaluationReadinessStatus: evalReady,
          certificationStatus: "NOT_ELIGIBLE",
          releaseStatus: "NOT_ELIGIBLE",
          agentVersionStatus: decision === "APPROVE" ? "CANDIDATE" : "DRAFT",
        };
      });
      return json(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "review_already_recorded" || message.includes("duplicate key")) {
        return json(res, 409, { error: "review_already_recorded" });
      }
      if (message === "candidate_not_ready" || message === "candidate_not_reviewable") {
        return json(res, 409, { error: message });
      }
      throw error;
    }
  }

  const revisionMatch = /^\/v1\/transformations\/([0-9a-f-]+)\/revisions$/.exec(url.pathname);
  if (req.method === "POST" && revisionMatch) {
    const parentTransformationId = revisionMatch[1]!;
    const role = await reviewerRoleForTransformation(user.id, parentTransformationId);
    if (!role) return json(res, 403, { error: "insufficient_workspace_role" });

    try {
      const result = await transaction(async (client) => {
        const parent = await client.query<{
          project_id: string; source_artifact_id: string; requested_name: string;
          requested_class: string; source_sha256: string; agent_version_id: string;
          rights_status: string; review_id: string; requested_changes: string;
        }>(
          `SELECT t.project_id,t.source_artifact_id,t.requested_name,t.requested_class,
                  t.source_sha256,t.agent_version_id,s.rights_status,
                  r.id review_id,r.requested_changes
           FROM promptforge_transformations t
           JOIN source_artifacts s ON s.id=t.source_artifact_id
           JOIN semantic_reviews r ON r.transformation_id=t.id
           WHERE t.id=$1 AND r.decision='REQUEST_CHANGES'
           FOR UPDATE`,
          [parentTransformationId],
        );
        const item = parent.rows[0];
        if (!item?.agent_version_id || !item.requested_changes) throw new Error("change_request_required");

        const child = await client.query<{ id: string }>(
          `INSERT INTO promptforge_transformations(
             project_id,source_artifact_id,requested_name,requested_class,status,
             configuration,source_sha256,created_by_user_id
           ) VALUES ($1,$2,$3,$4,'QUEUED',$5::jsonb,$6,$7)
           RETURNING id`,
          [
            item.project_id,item.source_artifact_id,item.requested_name,item.requested_class,
            JSON.stringify({
              rightsStatus:item.rights_status,apsVersion:"1.5-alpha",
              revisionRequest:item.requested_changes,parentTransformationId,
              parentAgentVersionId:item.agent_version_id,requestedByReviewId:item.review_id,
            }),
            item.source_sha256,user.id,
          ],
        );

        await client.query(
          `INSERT INTO candidate_revision_lineage(
             parent_transformation_id,child_transformation_id,parent_agent_version_id,
             requested_by_review_id,created_by_user_id
           ) VALUES ($1,$2,$3,$4,$5)`,
          [parentTransformationId,child.rows[0]!.id,item.agent_version_id,item.review_id,user.id],
        );

        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,authority_reference,evidence)
           VALUES ($1,'candidate_revision_queued','promptforge_transformation',$2,$3,$4::jsonb)`,
          [user.id,child.rows[0]!.id,item.review_id,JSON.stringify({parentTransformationId,parentAgentVersionId:item.agent_version_id})],
        );

        return { transformationId: child.rows[0]!.id, status: "QUEUED", parentTransformationId };
      });
      return json(res, 202, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("duplicate key")) return json(res, 409, { error: "revision_already_created" });
      if (message === "change_request_required") return json(res, 409, { error: message });
      throw error;
    }
  }


  if (req.method === "GET" && url.pathname === "/v1/evaluation-suites") {
    const suites = await query<{
      id:string; suite_key:string; version:string; name:string; definition:unknown;
    }>(
      `SELECT id,suite_key,version,name,definition
       FROM evaluation_suites
       ORDER BY suite_key,version`,
    );
    return json(res,200,{suites:suites.rows});
  }

  const evaluationPlanCreateMatch = /^\/v1\/transformations\/([0-9a-f-]+)\/evaluation-plan$/.exec(url.pathname);
  if (req.method === "POST" && evaluationPlanCreateMatch) {
    const transformationId=evaluationPlanCreateMatch[1]!;
    const role=await reviewerRoleForTransformation(user.id,transformationId);
    if(!role) return json(res,403,{error:"insufficient_workspace_role"});
    const body=await readJson(req);
    const requested=Array.isArray(body.suiteKeys)
      ? body.suiteKeys.filter((x):x is string=>typeof x==="string")
      : ["core-governance-v1","human-semantic-quality-v1"];
    const suiteKeys=[...new Set(requested)];
    if(!suiteKeys.length) return json(res,400,{error:"evaluation_suites_required"});

    try {
      const result=await transaction(async(client)=>{
        const subject=await client.query(
          `SELECT t.agent_version_id,av.status,l.semantic_approval_status,l.evaluation_readiness_status
           FROM promptforge_transformations t
           JOIN agent_versions av ON av.id=t.agent_version_id
           JOIN lifecycle_readiness l ON l.agent_version_id=av.id
           WHERE t.id=$1
           FOR UPDATE`,
          [transformationId],
        );
        const item=subject.rows[0];
        if(!item?.agent_version_id) throw new Error("candidate_not_ready");
        if(item.status!=="CANDIDATE") throw new Error("candidate_not_candidate");
        if(item.semantic_approval_status!=="APPROVED" || item.evaluation_readiness_status!=="READY") {
          throw new Error("candidate_not_evaluation_ready");
        }

        const existing=await client.query("SELECT id FROM evaluation_plans WHERE agent_version_id=$1",[item.agent_version_id]);
        if(existing.rowCount) throw new Error("evaluation_plan_exists");

        const suites=await client.query(
          `SELECT id,suite_key,version,name,definition
           FROM evaluation_suites
           WHERE suite_key=ANY($1::text[])
           ORDER BY suite_key`,
          [suiteKeys],
        );
        if(suites.rowCount!==suiteKeys.length) throw new Error("evaluation_suite_not_found");

        const plan=await client.query(
          `INSERT INTO evaluation_plans(agent_version_id,status,created_by_user_id)
           VALUES ($1,'PLANNING',$2) RETURNING id`,
          [item.agent_version_id,user.id],
        );
        const planId=plan.rows[0]!.id as string;

        for(let i=0;i<suites.rows.length;i++){
          const suite=suites.rows[i]!;
          await client.query(
            `INSERT INTO evaluation_plan_suites(plan_id,evaluation_suite_id,required,ordinal)
             VALUES ($1,$2,true,$3)`,
            [planId,suite.id,i],
          );
          await client.query(
            `INSERT INTO evaluation_suite_executions(plan_id,evaluation_suite_id,status)
             VALUES ($1,$2,'QUEUED')`,
            [planId,suite.id],
          );
        }

        await client.query("UPDATE evaluation_plans SET status='READY' WHERE id=$1",[planId]);
        await client.query(
          `UPDATE lifecycle_readiness
           SET evaluation_status='PLANNED',updated_at=now()
           WHERE agent_version_id=$1`,
          [item.agent_version_id],
        );
        await client.query(
          "UPDATE agent_versions SET status='VALIDATED' WHERE id=$1 AND status='CANDIDATE'",
          [item.agent_version_id],
        );
        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
           VALUES ($1,'evaluation_plan_ready','agent_version',$2,$3::jsonb)`,
          [user.id,item.agent_version_id,JSON.stringify({planId,suiteKeys,reviewerRole:role})],
        );

        return {
          planId,
          agentVersionId:item.agent_version_id,
          agentVersionStatus:"VALIDATED",
          evaluationStatus:"PLANNED",
          suites:suites.rows.map((s:any)=>({id:s.id,key:s.suite_key,version:s.version,name:s.name})),
        };
      });
      return json(res,201,result);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(["candidate_not_ready","candidate_not_candidate","candidate_not_evaluation_ready","evaluation_plan_exists","evaluation_suite_not_found"].includes(message)) {
        return json(res,409,{error:message});
      }
      throw error;
    }
  }

  const evaluationPlanMatch=/^\/v1\/evaluation-plans\/([0-9a-f-]+)$/.exec(url.pathname);
  if(req.method==="GET" && evaluationPlanMatch) {
    const planId=evaluationPlanMatch[1]!;
    const role=await reviewerRoleForEvaluationPlan(user.id,planId);
    if(!role) return json(res,403,{error:"insufficient_workspace_role"});

    const plan=await query(
      `SELECT p.id,p.agent_version_id,p.status,p.aggregate_outcome,
              p.created_at::text,p.started_at::text,p.completed_at::text,
              av.status agent_version_status,a.registry_id,av.version,
              l.semantic_approval_status,l.evaluation_readiness_status,l.evaluation_status,
              l.certification_readiness_status,l.certification_status,l.release_status
       FROM evaluation_plans p
       JOIN agent_versions av ON av.id=p.agent_version_id
       JOIN agents a ON a.id=av.agent_id
       JOIN lifecycle_readiness l ON l.agent_version_id=av.id
       WHERE p.id=$1`,
      [planId],
    );
    if(!plan.rows[0]) return json(res,404,{error:"not_found"});

    const executions=await query(
      `SELECT e.id,e.status,e.outcome,e.evaluation_run_id,e.machine_evidence,
              s.suite_key,s.version,s.name,ps.required,ps.ordinal,
              h.id human_review_id,h.outcome human_outcome,h.rationale human_rationale,
              hu.email human_reviewer_email,hu.display_name human_reviewer_name
       FROM evaluation_plan_suites ps
       JOIN evaluation_suites s ON s.id=ps.evaluation_suite_id
       JOIN evaluation_suite_executions e
         ON e.plan_id=ps.plan_id AND e.evaluation_suite_id=ps.evaluation_suite_id
       LEFT JOIN human_evaluation_records h ON h.execution_id=e.id
       LEFT JOIN app_users hu ON hu.id=h.reviewer_user_id
       WHERE ps.plan_id=$1
       ORDER BY ps.ordinal`,
      [planId],
    );

    const readiness=await query(
      `SELECT d.id,d.decision,d.rationale,d.aggregate_outcome,d.created_at::text,
              u.email reviewer_email,u.display_name reviewer_name,d.reviewer_role
       FROM certification_readiness_decisions d
       JOIN app_users u ON u.id=d.reviewer_user_id
       WHERE d.evaluation_plan_id=$1`,
      [planId],
    );

    return json(res,200,{
      plan:plan.rows[0],
      executions:executions.rows,
      certificationReadinessDecision:readiness.rows[0]??null,
    });
  }

  const humanEvalMatch=/^\/v1\/evaluation-executions\/([0-9a-f-]+)\/human-review$/.exec(url.pathname);
  if(req.method==="POST" && humanEvalMatch) {
    const executionId=humanEvalMatch[1]!;
    const role=await reviewerRoleForEvaluationExecution(user.id,executionId);
    if(!role) return json(res,403,{error:"insufficient_workspace_role"});
    const body=await readJson(req);
    const outcome=typeof body.outcome==="string"?body.outcome:"";
    const rationale=typeof body.rationale==="string"?body.rationale.trim():"";
    const evidence=Array.isArray(body.evidence)?body.evidence.filter((x):x is string=>typeof x==="string"):[];
    if(!["PASS","PARTIAL","FAIL"].includes(outcome)) return json(res,400,{error:"invalid_human_evaluation_outcome"});
    if(rationale.length<3) return json(res,400,{error:"human_evaluation_rationale_required"});

    try {
      const result=await transaction(async(client)=>{
        const execution=await client.query(
          `SELECT e.id,e.plan_id,e.evaluation_suite_id,e.status,e.machine_evidence,
                  p.agent_version_id
           FROM evaluation_suite_executions e
           JOIN evaluation_plans p ON p.id=e.plan_id
           WHERE e.id=$1
           FOR UPDATE`,
          [executionId],
        );
        const item=execution.rows[0];
        if(!item) throw new Error("evaluation_execution_not_found");
        if(item.status!=="AWAITING_HUMAN") throw new Error("evaluation_execution_not_awaiting_human");

        const existing=await client.query("SELECT 1 FROM human_evaluation_records WHERE execution_id=$1",[executionId]);
        if(existing.rowCount) throw new Error("human_evaluation_already_recorded");

        const prior=(item.machine_evidence??[]) as AssertionResult[];
        const completed=applyHumanReview(prior,{
          identity:user.email,role,rationale,
        },outcome as "PASS"|"PARTIAL"|"FAIL");

        const human=await client.query(
          `INSERT INTO human_evaluation_records(
             execution_id,reviewer_user_id,reviewer_role,outcome,rationale,evidence
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
           RETURNING id,created_at::text`,
          [executionId,user.id,role,outcome,rationale,JSON.stringify(evidence)],
        );

        const run=await client.query(
          `INSERT INTO evaluation_runs(
             agent_version_id,evaluation_suite_id,outcome,evidence,started_at,completed_at
           ) VALUES ($1,$2,$3,$4::jsonb,now(),now())
           RETURNING id`,
          [
            item.agent_version_id,item.evaluation_suite_id,outcome,
            JSON.stringify({
              runtime:{target:"human-review",identity:user.email},
              results:completed,
              evidence,
            }),
          ],
        );

        for(const assertion of completed) {
          await client.query(
            `INSERT INTO evaluation_results(evaluation_run_id,case_key,outcome,evidence)
             VALUES ($1,$2,$3,$4::jsonb)`,
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
          [outcome,run.rows[0]!.id,JSON.stringify(completed),executionId],
        );

        const aggregate=await refreshEvaluationPlanClient(client,item.plan_id);

        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,authority_reference,evidence)
           VALUES ($1,'human_evaluation_recorded','evaluation_run',$2,$3,$4::jsonb)`,
          [
            user.id,run.rows[0]!.id,human.rows[0]!.id,
            JSON.stringify({planId:item.plan_id,executionId,outcome,reviewerRole:role}),
          ],
        );

        return {
          humanEvaluationId:human.rows[0]!.id,
          evaluationRunId:run.rows[0]!.id,
          planId:item.plan_id,
          outcome,
          planStatus:aggregate.status,
          aggregateOutcome:aggregate.aggregateOutcome,
        };
      });
      return json(res,200,result);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(["evaluation_execution_not_found","evaluation_execution_not_awaiting_human","human_evaluation_already_recorded"].includes(message)) {
        return json(res,409,{error:message});
      }
      throw error;
    }
  }

  const certReadinessMatch=/^\/v1\/evaluation-plans\/([0-9a-f-]+)\/certification-readiness$/.exec(url.pathname);
  if(req.method==="POST" && certReadinessMatch) {
    const planId=certReadinessMatch[1]!;
    const role=await reviewerRoleForEvaluationPlan(user.id,planId);
    if(!role) return json(res,403,{error:"insufficient_workspace_role"});
    const body=await readJson(req);
    const decision=typeof body.decision==="string"?body.decision:"";
    const rationale=typeof body.rationale==="string"?body.rationale.trim():"";
    if(!["ELIGIBLE","NOT_ELIGIBLE"].includes(decision)) return json(res,400,{error:"invalid_certification_readiness_decision"});
    if(rationale.length<3) return json(res,400,{error:"certification_readiness_rationale_required"});

    try {
      const result=await transaction(async(client)=>{
        const plan=await client.query(
          `SELECT p.agent_version_id,p.status,p.aggregate_outcome,av.status agent_version_status
           FROM evaluation_plans p
           JOIN agent_versions av ON av.id=p.agent_version_id
           WHERE p.id=$1
           FOR UPDATE`,
          [planId],
        );
        const item=plan.rows[0];
        if(!item) throw new Error("evaluation_plan_not_found");
        if(item.status!=="COMPLETED" || item.agent_version_status!=="EVALUATED") throw new Error("evaluation_not_complete");

        const existing=await client.query("SELECT 1 FROM certification_readiness_decisions WHERE agent_version_id=$1",[item.agent_version_id]);
        if(existing.rowCount) throw new Error("certification_readiness_already_recorded");

        const readiness=await client.query(
          `INSERT INTO certification_readiness_decisions(
             agent_version_id,evaluation_plan_id,reviewer_user_id,reviewer_role,
             decision,rationale,aggregate_outcome
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id,created_at::text`,
          [
            item.agent_version_id,planId,user.id,role,decision,rationale,item.aggregate_outcome,
          ],
        );

        await client.query(
          `UPDATE lifecycle_readiness
           SET certification_readiness_status=$1,
               certification_status=$2,
               updated_at=now()
           WHERE agent_version_id=$3`,
          [
            decision,
            decision==="ELIGIBLE"?"ELIGIBLE":"NOT_ELIGIBLE",
            item.agent_version_id,
          ],
        );

        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,authority_reference,evidence)
           VALUES ($1,'certification_readiness_decided','agent_version',$2,$3,$4::jsonb)`,
          [
            user.id,item.agent_version_id,readiness.rows[0]!.id,
            JSON.stringify({planId,decision,aggregateOutcome:item.aggregate_outcome,reviewerRole:role}),
          ],
        );

        return {
          decisionId:readiness.rows[0]!.id,
          agentVersionId:item.agent_version_id,
          decision,
          certificationStatus:decision==="ELIGIBLE"?"ELIGIBLE":"NOT_ELIGIBLE",
          agentVersionStatus:"EVALUATED",
        };
      });
      return json(res,200,result);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(["evaluation_plan_not_found","evaluation_not_complete","certification_readiness_already_recorded"].includes(message) || message.includes("ELIGIBLE certification readiness requires PASS aggregate")) {
        return json(res,409,{error:message});
      }
      throw error;
    }
  }


  const certificationMatch=/^\/v1\/evaluation-plans\/([0-9a-f-]+)\/certification$/.exec(url.pathname);
  if(req.method==="POST" && certificationMatch) {
    const planId=certificationMatch[1]!;
    const plan=await query<{agent_version_id:string}>("SELECT agent_version_id FROM evaluation_plans WHERE id=$1",[planId]);
    const agentVersionId=plan.rows[0]?.agent_version_id;
    if(!agentVersionId) return json(res,404,{error:"evaluation_plan_not_found"});
    const role=await authorityRoleForAgentVersion(user.id,agentVersionId);
    if(!role) return json(res,403,{error:"certification_authority_required"});

    const body=await readJson(req);
    const decision=typeof body.decision==="string"?body.decision:"";
    const rationale=typeof body.rationale==="string"?body.rationale.trim():"";
    const evidence=Array.isArray(body.evidence)?body.evidence.filter((x):x is string=>typeof x==="string"&&x.trim().length>0):[];
    if(!["CERTIFY","DENY"].includes(decision)) return json(res,400,{error:"invalid_certification_decision"});
    if(rationale.length<3) return json(res,400,{error:"certification_rationale_required"});
    if(decision==="CERTIFY" && !evidence.length) return json(res,400,{error:"certification_evidence_required"});

    try {
      const result=await transaction(async(client)=>{
        const state=await client.query<{
          agent_version_id:string; status:string; aggregate_outcome:string;
          readiness_decision_id:string; readiness_decision:string;
          certification_status:string; certification_readiness_status:string;
          aps_sha256:string;
        }>(
          `SELECT p.agent_version_id,av.status,p.aggregate_outcome,
                  d.id readiness_decision_id,d.decision readiness_decision,
                  l.certification_status,l.certification_readiness_status,
                  aps.sha256 aps_sha256
           FROM evaluation_plans p
           JOIN agent_versions av ON av.id=p.agent_version_id
           JOIN lifecycle_readiness l ON l.agent_version_id=av.id
           JOIN certification_readiness_decisions d ON d.agent_version_id=av.id
           JOIN aps_specifications aps ON aps.agent_version_id=av.id
           WHERE p.id=$1
           FOR UPDATE`,
          [planId],
        );
        const item=state.rows[0];
        if(!item) throw new Error("certification_context_missing");
        if(item.status!=="EVALUATED") throw new Error("agent_not_evaluated");
        if(item.readiness_decision!=="ELIGIBLE" || item.certification_readiness_status!=="ELIGIBLE" || item.certification_status!=="ELIGIBLE") {
          throw new Error("agent_not_certification_eligible");
        }
        const existing=await client.query("SELECT 1 FROM certification_records WHERE agent_version_id=$1",[item.agent_version_id]);
        if(existing.rowCount) throw new Error("certification_already_recorded");

        const evidenceBundle={
          evidence,
          evaluationPlanId:planId,
          readinessDecisionId:item.readiness_decision_id,
          canonicalApsSha256:item.aps_sha256,
          evaluationAggregate:item.aggregate_outcome,
        };

        const record=await client.query<{id:string;created_at:string}>(
          `INSERT INTO certification_records(
             agent_version_id,evaluation_plan_id,readiness_decision_id,
             certifier_user_id,certifier_role,decision,rationale,evidence_bundle,
             canonical_aps_sha256,evaluation_aggregate
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
           RETURNING id,created_at::text`,
          [
            item.agent_version_id,planId,item.readiness_decision_id,user.id,role,
            decision,rationale,JSON.stringify(evidenceBundle),item.aps_sha256,item.aggregate_outcome,
          ],
        );

        if(decision==="CERTIFY") {
          await client.query(
            `UPDATE lifecycle_readiness
             SET certification_decision_status='CERTIFIED',
                 certification_status='CERTIFIED',
                 release_approval_status='NOT_REVIEWED',
                 release_status='NOT_ELIGIBLE',
                 updated_at=now()
             WHERE agent_version_id=$1`,
            [item.agent_version_id],
          );
          await client.query(
            "UPDATE agent_versions SET status='CERTIFIED' WHERE id=$1 AND status='EVALUATED'",
            [item.agent_version_id],
          );
        } else {
          await client.query(
            `UPDATE lifecycle_readiness
             SET certification_decision_status='DENIED',
                 certification_status='NOT_ELIGIBLE',
                 release_approval_status='NOT_REVIEWED',
                 release_status='NOT_ELIGIBLE',
                 updated_at=now()
             WHERE agent_version_id=$1`,
            [item.agent_version_id],
          );
        }

        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,authority_reference,evidence)
           VALUES ($1,$2,'agent_version',$3,$4,$5::jsonb)`,
          [
            user.id,
            decision==="CERTIFY"?"certification_granted":"certification_denied",
            item.agent_version_id,
            record.rows[0]!.id,
            JSON.stringify({planId,decision,certifierRole:role,apsSha256:item.aps_sha256}),
          ],
        );

        return {
          certificationRecordId:record.rows[0]!.id,
          decision,
          agentVersionId:item.agent_version_id,
          agentVersionStatus:decision==="CERTIFY"?"CERTIFIED":"EVALUATED",
          certificationStatus:decision==="CERTIFY"?"CERTIFIED":"NOT_ELIGIBLE",
          releaseApprovalStatus:"NOT_REVIEWED",
          packagingStatus:"NOT_PACKAGED",
          publicationStatus:"NOT_PUBLISHED",
          frankaiRegistrationStatus:"NOT_REGISTERED",
        };
      });
      return json(res,200,result);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(["certification_context_missing","agent_not_evaluated","agent_not_certification_eligible","certification_already_recorded"].includes(message) || message.includes("certification requires")) {
        return json(res,409,{error:message});
      }
      throw error;
    }
  }

  const releaseApprovalMatch=/^\/v1\/agent-versions\/([0-9a-f-]+)\/release-approval$/.exec(url.pathname);
  if(req.method==="POST" && releaseApprovalMatch) {
    const agentVersionId=releaseApprovalMatch[1]!;
    const role=await authorityRoleForAgentVersion(user.id,agentVersionId);
    if(!role) return json(res,403,{error:"release_authority_required"});
    const body=await readJson(req);
    const decision=typeof body.decision==="string"?body.decision:"";
    const rationale=typeof body.rationale==="string"?body.rationale.trim():"";
    const intendedDistribution=typeof body.intendedDistribution==="string"?body.intendedDistribution.trim():"";
    if(!["APPROVE","DENY"].includes(decision)) return json(res,400,{error:"invalid_release_approval_decision"});
    if(rationale.length<3) return json(res,400,{error:"release_approval_rationale_required"});
    if(intendedDistribution.length<3) return json(res,400,{error:"intended_distribution_required"});

    try {
      const result=await transaction(async(client)=>{
        const context=await client.query<{
          status:string; certification_record_id:string; certification_decision:string;
          certification_decision_status:string; rights_status:string;
        }>(
          `SELECT av.status,c.id certification_record_id,c.decision certification_decision,
                  l.certification_decision_status,s.rights_status
           FROM agent_versions av
           JOIN certification_records c ON c.agent_version_id=av.id
           JOIN lifecycle_readiness l ON l.agent_version_id=av.id
           JOIN promptforge_transformations t ON t.agent_version_id=av.id
           JOIN source_artifacts s ON s.id=t.source_artifact_id
           WHERE av.id=$1
           ORDER BY t.created_at DESC
           LIMIT 1
           FOR UPDATE OF av,l`,
          [agentVersionId],
        );
        const item=context.rows[0];
        if(!item) throw new Error("release_approval_context_missing");
        if(item.status!=="CERTIFIED" || item.certification_decision!=="CERTIFY" || item.certification_decision_status!=="CERTIFIED") {
          throw new Error("agent_not_certified");
        }
        const existing=await client.query("SELECT 1 FROM release_approval_records WHERE agent_version_id=$1",[agentVersionId]);
        if(existing.rowCount) throw new Error("release_approval_already_recorded");

        const record=await client.query<{id:string;created_at:string}>(
          `INSERT INTO release_approval_records(
             agent_version_id,certification_record_id,approver_user_id,approver_role,
             decision,rationale,intended_distribution,rights_status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,created_at::text`,
          [
            agentVersionId,item.certification_record_id,user.id,role,decision,rationale,
            intendedDistribution,item.rights_status,
          ],
        );

        await client.query(
          `UPDATE lifecycle_readiness
           SET release_approval_status=$1,
               release_status=$2,
               updated_at=now()
           WHERE agent_version_id=$3`,
          [
            decision==="APPROVE"?"APPROVED":"DENIED",
            decision==="APPROVE"?"ELIGIBLE":"NOT_ELIGIBLE",
            agentVersionId,
          ],
        );

        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,authority_reference,evidence)
           VALUES ($1,$2,'agent_version',$3,$4,$5::jsonb)`,
          [
            user.id,
            decision==="APPROVE"?"release_approval_granted":"release_approval_denied",
            agentVersionId,
            record.rows[0]!.id,
            JSON.stringify({decision,intendedDistribution,rightsStatus:item.rights_status,approverRole:role}),
          ],
        );

        return {
          releaseApprovalId:record.rows[0]!.id,
          decision,
          agentVersionId,
          releaseApprovalStatus:decision==="APPROVE"?"APPROVED":"DENIED",
          releaseStatus:decision==="APPROVE"?"ELIGIBLE":"NOT_ELIGIBLE",
          packagingStatus:"NOT_PACKAGED",
          publicationStatus:"NOT_PUBLISHED",
          frankaiRegistrationStatus:"NOT_REGISTERED",
          rightsStatus:item.rights_status,
        };
      });
      return json(res,200,result);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(["release_approval_context_missing","agent_not_certified","release_approval_already_recorded"].includes(message) || message.includes("release approval requires")) {
        return json(res,409,{error:message});
      }
      throw error;
    }
  }


  const packageMatch=/^\/v1\/agent-versions\/([0-9a-f-]+)\/package$/.exec(url.pathname);
  if(req.method==="POST" && packageMatch) {
    const agentVersionId=packageMatch[1]!;
    const role=await authorityRoleForAgentVersion(user.id,agentVersionId);
    if(!role) return json(res,403,{error:"packaging_authority_required"});
    const body=await readJson(req);
    const releaseVersion=typeof body.releaseVersion==="string"?body.releaseVersion.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey.trim():"";
    if(!releaseVersion) return json(res,400,{error:"release_version_required"});
    try { assertSafeObjectKeySegment(releaseVersion,"release_version"); }
    catch { return json(res,400,{error:"release_version_invalid"}); }
    if(idempotencyKey.length<8) return json(res,400,{error:"idempotency_key_required"});

    try {
      const result=await transaction(async(client)=>{
        const existingByKey=await client.query(
          `SELECT id,agent_version_id,release_id,package_sha256,package_manifest,created_at::text
           FROM release_package_records WHERE idempotency_key=$1`,
          [idempotencyKey],
        );
        if(existingByKey.rowCount) {
          const existing=existingByKey.rows[0];
          if(existing.agent_version_id!==agentVersionId) throw new Error("idempotency_key_conflict");
          return {
            packageRecordId:existing.id,
            releaseId:existing.release_id,
            packageSha256:existing.package_sha256,
            manifest:existing.package_manifest,
            packagingStatus:"PACKAGED",
            idempotentReplay:true,
          };
        }

        const existingPackage=await client.query(
          "SELECT id FROM release_package_records WHERE agent_version_id=$1",
          [agentVersionId],
        );
        if(existingPackage.rowCount) throw new Error("package_already_exists");

        const context=await client.query<{
          registry_id:string; version:string; status:string; workspace_id:string;
          aps_document:any; aps_sha256:string;
          evaluation_plan_id:string; aggregate_outcome:string;
          certification_record_id:string; certification_evidence:any; certifier_role:string;
          release_approval_id:string; rights_status:string; intended_distribution:string; approver_role:string;
        }>(
          `SELECT a.registry_id,av.version,av.status,pj.workspace_id,
                  aps.document aps_document,aps.sha256 aps_sha256,
                  ep.id evaluation_plan_id,ep.aggregate_outcome,
                  cr.id certification_record_id,cr.evidence_bundle certification_evidence,cr.certifier_role,
                  ra.id release_approval_id,ra.rights_status,ra.intended_distribution,ra.approver_role
           FROM agent_versions av
           JOIN agents a ON a.id=av.agent_id
           JOIN aps_specifications aps ON aps.agent_version_id=av.id
           JOIN evaluation_plans ep ON ep.agent_version_id=av.id
           JOIN certification_records cr ON cr.agent_version_id=av.id AND cr.decision='CERTIFY'
           JOIN release_approval_records ra ON ra.agent_version_id=av.id AND ra.decision='APPROVE'
           JOIN lifecycle_readiness l ON l.agent_version_id=av.id
           JOIN promptforge_transformations pt ON pt.agent_version_id=av.id
           JOIN projects pj ON pj.id=pt.project_id
           WHERE av.id=$1
             AND av.status='CERTIFIED'
             AND l.release_approval_status='APPROVED'
             AND l.packaging_status='NOT_PACKAGED'
           FOR UPDATE OF av,l`,
          [agentVersionId],
        );
        const item=context.rows[0];
        if(!item) throw new Error("package_not_authorized");

        const runs=await client.query<{
          id:string;outcome:string;suite_key:string;
        }>(
          `SELECT er.id,er.outcome,es.suite_key
           FROM evaluation_runs er
           JOIN evaluation_suites es ON es.id=er.evaluation_suite_id
           WHERE er.agent_version_id=$1
           ORDER BY er.created_at`,
          [agentVersionId],
        );

        const built=buildReleaseBundle({
          releaseVersion,
          registryId:item.registry_id,
          agentVersion:item.version,
          aps:item.aps_document,
          apsSha256:item.aps_sha256,
          evaluationPlan:{id:item.evaluation_plan_id,aggregateOutcome:item.aggregate_outcome},
          evaluationRuns:runs.rows.map(r=>({id:r.id,outcome:r.outcome,suiteKey:r.suite_key})),
          certification:{id:item.certification_record_id,evidenceBundle:item.certification_evidence,certifierRole:item.certifier_role},
          releaseApproval:{id:item.release_approval_id,rightsStatus:item.rights_status,intendedDistribution:item.intended_distribution,approverRole:item.approver_role},
        });

        const digestResult=await client.query<{sha256:string}>(
          "SELECT encode(digest(convert_to($1::jsonb::text,'UTF8'),'sha256'),'hex') sha256",
          [JSON.stringify(built.content)],
        );
        const packageSha256=digestResult.rows[0]!.sha256;
        const manifest={...built.manifest,packageSha256};

        const release=await client.query<{id:string}>(
          `INSERT INTO releases(agent_version_id,release_version,integrity_sha256)
           VALUES ($1,$2,$3)
           RETURNING id`,
          [agentVersionId,releaseVersion,packageSha256],
        );

        const packageRecord=await client.query<{id:string}>(
          `INSERT INTO release_package_records(
             agent_version_id,release_approval_id,release_id,package_sha256,package_location,
             idempotency_key,package_manifest,package_content,created_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
           RETURNING id`,
          [
            agentVersionId,item.release_approval_id,release.rows[0]!.id,packageSha256,
            "database://release_package_records",idempotencyKey,
            JSON.stringify(manifest),JSON.stringify(built.content),user.id,
          ],
        );

        const packageObjectKey=`workspaces/${item.workspace_id}/agents/${item.registry_id}/versions/${item.version}/releases/${releaseVersion}/package.json`;
        const packageStorageBody=canonicalJson(built.content);
        const packageStorageSha256=sha256Text(packageStorageBody);
        const artifact=await client.query<{id:string}>(
          `INSERT INTO artifact_objects(
             workspace_id,agent_version_id,kind,object_key,sha256,media_type,byte_size
           ) VALUES ($1,$2,'RELEASE_PACKAGE',$3,$4,'application/json',$5)
           RETURNING id`,
          [
            item.workspace_id,agentVersionId,packageObjectKey,packageStorageSha256,
            Buffer.byteLength(packageStorageBody),
          ],
        );
        await client.query(
          `INSERT INTO operational_jobs(workspace_id,job_type,payload)
           VALUES ($1,'STORE_ARTIFACT',$2::jsonb)`,
          [
            item.workspace_id,
            JSON.stringify({
              artifactObjectId:artifact.rows[0]!.id,
              objectKey:packageObjectKey,
              content:built.content,
              expectedSha256:packageStorageSha256,
            }),
          ],
        );

        await client.query(
          `UPDATE lifecycle_readiness
           SET packaging_status='PACKAGED',updated_at=now()
           WHERE agent_version_id=$1`,
          [agentVersionId],
        );
        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,authority_reference,evidence)
           VALUES ($1,'release_package_created','release_package',$2,$3,$4::jsonb)`,
          [
            user.id,packageRecord.rows[0]!.id,item.release_approval_id,
            JSON.stringify({agentVersionId,releaseVersion,packageSha256,idempotencyKey,runtimeTargets:["generic","openai"]}),
          ],
        );

        return {
          packageRecordId:packageRecord.rows[0]!.id,
          releaseId:release.rows[0]!.id,
          packageSha256,
          manifest,
          packagingStatus:"PACKAGED",
          publicationStatus:"NOT_PUBLISHED",
          frankaiRegistrationStatus:"NOT_REGISTERED",
          idempotentReplay:false,
        };
      });
      return json(res,201,result);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(["idempotency_key_conflict","package_already_exists","package_not_authorized"].includes(message) || message.includes("packaging requires")) {
        return json(res,409,{error:message});
      }
      throw error;
    }
  }

  const publishMatch=/^\/v1\/release-packages\/([0-9a-f-]+)\/publish$/.exec(url.pathname);
  if(req.method==="POST" && publishMatch) {
    const packageRecordId=publishMatch[1]!;
    const role=await authorityRoleForReleasePackage(user.id,packageRecordId);
    if(!role) return json(res,403,{error:"publication_authority_required"});
    const body=await readJson(req);
    const channel=typeof body.channel==="string"?body.channel.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey.trim():"";
    const externalReference=typeof body.externalReference==="string"?body.externalReference.trim():null;
    if(channel.length<2) return json(res,400,{error:"publication_channel_required"});
    if(idempotencyKey.length<8) return json(res,400,{error:"idempotency_key_required"});

    try {
      const result=await transaction(async(client)=>{
        const existingByKey=await client.query(
          `SELECT id,release_package_record_id,channel,external_reference,publication_payload,published_at::text
           FROM publication_records WHERE idempotency_key=$1`,
          [idempotencyKey],
        );
        if(existingByKey.rowCount) {
          const existing=existingByKey.rows[0];
          if(existing.release_package_record_id!==packageRecordId || existing.channel!==channel) {
            throw new Error("idempotency_key_conflict");
          }
          return {
            publicationRecordId:existing.id,
            packageRecordId,
            channel:existing.channel,
            externalReference:existing.external_reference,
            payload:existing.publication_payload,
            publicationStatus:"PUBLISHED",
            idempotentReplay:true,
          };
        }

        const existingPublication=await client.query(
          "SELECT id FROM publication_records WHERE release_package_record_id=$1 AND channel=$2",
          [packageRecordId,channel],
        );
        if(existingPublication.rowCount) throw new Error("publication_already_exists");

        const context=await client.query<{
          agent_version_id:string;package_sha256:string;package_manifest:any;
          release_id:string;release_version:string;registry_id:string;version:string;rights_status:string;workspace_id:string;
        }>(
          `SELECT rp.agent_version_id,rp.package_sha256,rp.package_manifest,
                  r.id release_id,r.release_version,a.registry_id,av.version,ra.rights_status,pj.workspace_id
           FROM release_package_records rp
           JOIN releases r ON r.id=rp.release_id
           JOIN agent_versions av ON av.id=rp.agent_version_id
           JOIN agents a ON a.id=av.agent_id
           JOIN release_approval_records ra ON ra.id=rp.release_approval_id
           JOIN lifecycle_readiness l ON l.agent_version_id=rp.agent_version_id
           JOIN promptforge_transformations pt ON pt.agent_version_id=rp.agent_version_id
           JOIN projects pj ON pj.id=pt.project_id
           WHERE rp.id=$1
             AND l.packaging_status='PACKAGED'
             AND l.publication_status='NOT_PUBLISHED'
           FOR UPDATE OF l`,
          [packageRecordId],
        );
        const item=context.rows[0];
        if(!item) throw new Error("package_not_publishable");

        const runtimeTargets=Array.isArray(item.package_manifest?.runtimeTargets)
          ? item.package_manifest.runtimeTargets
          : ["generic","openai"];
        const publishedAt=new Date().toISOString();
        const payload=buildPublicationPayload({
          packageRecordId,
          packageSha256:item.package_sha256,
          releaseId:item.release_id,
          releaseVersion:item.release_version,
          registryId:item.registry_id,
          agentVersion:item.version,
          channel,
          rightsStatus:item.rights_status,
          runtimeTargets,
          apsVersion:item.package_manifest?.apsVersion,
          capabilities:item.package_manifest?.capabilities,
          evaluationAggregate:item.package_manifest?.evaluationAggregate,
          evaluationRequiredOutcome:item.package_manifest?.evaluationRequiredOutcome,
          evaluationRunIds:item.package_manifest?.evaluationRunIds,
          publishedAt,
        });

        const record=await client.query<{id:string}>(
          `INSERT INTO publication_records(
             release_package_record_id,channel,external_reference,published_by_user_id,
             idempotency_key,publication_payload,published_at,status
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'PUBLISHED')
           RETURNING id`,
          [packageRecordId,channel,externalReference,user.id,idempotencyKey,JSON.stringify(payload),publishedAt],
        );

        const publicationObjectKey=`workspaces/${item.workspace_id}/agents/${item.registry_id}/versions/${item.version}/publications/${record.rows[0]!.id}.json`;
        const publicationStorageBody=canonicalJson(payload);
        const publicationStorageSha256=sha256Text(publicationStorageBody);
        const publicationArtifact=await client.query<{id:string}>(
          `INSERT INTO artifact_objects(
             workspace_id,agent_version_id,kind,object_key,sha256,media_type,byte_size
           ) VALUES ($1,$2,'PUBLICATION_PAYLOAD',$3,$4,'application/json',$5)
           RETURNING id`,
          [
            item.workspace_id,item.agent_version_id,publicationObjectKey,publicationStorageSha256,
            Buffer.byteLength(publicationStorageBody),
          ],
        );
        await client.query(
          `INSERT INTO operational_jobs(workspace_id,job_type,payload)
           VALUES ($1,'STORE_ARTIFACT',$2::jsonb)`,
          [
            item.workspace_id,
            JSON.stringify({
              artifactObjectId:publicationArtifact.rows[0]!.id,
              objectKey:publicationObjectKey,
              content:payload,
              expectedSha256:publicationStorageSha256,
            }),
          ],
        );

        await client.query(
          `UPDATE lifecycle_readiness
           SET publication_status='PUBLISHED',updated_at=now()
           WHERE agent_version_id=$1`,
          [item.agent_version_id],
        );
        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
           VALUES ($1,'release_published','publication',$2,$3::jsonb)`,
          [user.id,record.rows[0]!.id,JSON.stringify({packageRecordId,channel,idempotencyKey,externalReference})],
        );

        return {
          publicationRecordId:record.rows[0]!.id,
          packageRecordId,
          channel,
          externalReference,
          payload,
          publicationStatus:"PUBLISHED",
          frankaiRegistrationStatus:"NOT_REGISTERED",
          idempotentReplay:false,
        };
      });
      return json(res,201,result);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(["idempotency_key_conflict","publication_already_exists","package_not_publishable"].includes(message) || message.includes("publication requires")) {
        return json(res,409,{error:message});
      }
      throw error;
    }
  }

  const registerMatch=/^\/v1\/publications\/([0-9a-f-]+)\/frankai-register$/.exec(url.pathname);
  if(req.method==="POST" && registerMatch) {
    const publicationId=registerMatch[1]!;
    const role=await authorityRoleForPublication(user.id,publicationId);
    if(!role) return json(res,403,{error:"frankai_registration_authority_required"});
    const body=await readJson(req);
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey.trim():"";
    if(idempotencyKey.length<8) return json(res,400,{error:"idempotency_key_required"});

    const existing=await query<{
      id:string;publication_record_id:string;registration_reference:string;request_payload:any;response_payload:any;
    }>(
      "SELECT id,publication_record_id,registration_reference,request_payload,response_payload FROM frankai_registration_records WHERE idempotency_key=$1",
      [idempotencyKey],
    );
    if(existing.rowCount) {
      const row=existing.rows[0]!;
      if(row.publication_record_id!==publicationId) return json(res,409,{error:"idempotency_key_conflict"});
      return json(res,200,{
        registrationRecordId:row.id,
        publicationRecordId:publicationId,
        registrationReference:row.registration_reference,
        requestPayload:row.request_payload,
        responsePayload:row.response_payload,
        frankaiRegistrationStatus:"REGISTERED",
        idempotentReplay:true,
      });
    }

    const existingForPublication=await query(
      "SELECT id FROM frankai_registration_records WHERE publication_record_id=$1",
      [publicationId],
    );
    if(existingForPublication.rowCount) return json(res,409,{error:"frankai_registration_already_exists"});

    const context=await query<{
      agent_version_id:string;publication_payload:any;publication_status:string;workspace_id:string;registry_id:string;version:string;
    }>(
      `SELECT rp.agent_version_id,p.publication_payload,l.publication_status,pj.workspace_id,a.registry_id,av.version
       FROM publication_records p
       JOIN release_package_records rp ON rp.id=p.release_package_record_id
       JOIN lifecycle_readiness l ON l.agent_version_id=rp.agent_version_id
       JOIN agent_versions av ON av.id=rp.agent_version_id
       JOIN agents a ON a.id=av.agent_id
       JOIN promptforge_transformations pt ON pt.agent_version_id=rp.agent_version_id
       JOIN projects pj ON pj.id=pt.project_id
       WHERE p.id=$1`,
      [publicationId],
    );
    const item=context.rows[0];
    if(!item || item.publication_status!=="PUBLISHED") return json(res,409,{error:"publication_not_registerable"});

    const registryUrl=process.env.FRANKAI_REGISTRY_URL;
    if(!registryUrl) return json(res,503,{error:"frankai_registry_not_configured"});

    let payload:any;
    try {
      payload=buildFrankAIRegistrationPayload({
        publicationRecordId:publicationId,
        publicationPayload:item.publication_payload,
      });
    } catch {
      return json(res,409,{error:"registration_contract_incomplete"});
    }

    // Claim the stable external effect before leaving the local transaction.
    // A different caller/key cannot create a second effect for this publication;
    // a retry with the same key may safely resume an IN_FLIGHT/FAILED attempt.
    try {
      await transaction(async(client)=>{
        await client.query(
          `INSERT INTO frankai_registration_attempts(publication_record_id,idempotency_key,request_payload)
           VALUES ($1,$2,$3::jsonb)
           ON CONFLICT DO NOTHING`,
          [publicationId,idempotencyKey,JSON.stringify(payload)],
        );
        const byPublication=await client.query<{idempotency_key:string;status:string}>(
          "SELECT idempotency_key,status FROM frankai_registration_attempts WHERE publication_record_id=$1 FOR UPDATE",
          [publicationId],
        );
        if(byPublication.rows[0]?.idempotency_key!==idempotencyKey) {
          throw new Error("frankai_registration_already_exists");
        }
      });
    } catch(error) {
      if(error instanceof Error && error.message==="frankai_registration_already_exists") {
        return json(res,409,{error:error.message});
      }
      throw error;
    }

    let registryResponse:Response;
    try {
      registryResponse=await fetch(registryUrl,{
        method:"POST",
        headers:{"content-type":"application/json","idempotency-key":idempotencyKey},
        body:JSON.stringify(payload),
      });
    } catch {
      await query(
        "UPDATE frankai_registration_attempts SET status='FAILED',last_error=$2,updated_at=now() WHERE publication_record_id=$1",
        [publicationId,"frankai_registry_unreachable"],
      );
      return json(res,502,{error:"frankai_registry_unreachable"});
    }

    const responseText=await registryResponse.text();
    let responsePayload:any={};
    try { responsePayload=responseText?JSON.parse(responseText):{}; }
    catch { responsePayload={raw:responseText}; }

    if(!registryResponse.ok) {
      await query(
        "UPDATE frankai_registration_attempts SET status='FAILED',response_payload=$2::jsonb,last_error=$3,updated_at=now() WHERE publication_record_id=$1",
        [publicationId,JSON.stringify(responsePayload),`HTTP ${registryResponse.status}`],
      );
      return json(res,502,{error:"frankai_registry_rejected",status:registryResponse.status,response:responsePayload});
    }
    const registrationReference=typeof responsePayload.registration_reference==="string"
      ? responsePayload.registration_reference
      : typeof responsePayload.id==="string"
        ? responsePayload.id
        : null;
    if(!registrationReference) {
      await query(
        "UPDATE frankai_registration_attempts SET status='FAILED',response_payload=$2::jsonb,last_error=$3,updated_at=now() WHERE publication_record_id=$1",
        [publicationId,JSON.stringify(responsePayload),"missing registration reference"],
      );
      return json(res,502,{error:"frankai_registry_missing_reference"});
    }

    try {
      const result=await transaction(async(client)=>{
        const recheck=await client.query("SELECT id FROM frankai_registration_records WHERE publication_record_id=$1",[publicationId]);
        if(recheck.rowCount) throw new Error("frankai_registration_already_exists");

        const record=await client.query<{id:string}>(
          `INSERT INTO frankai_registration_records(
             publication_record_id,registration_reference,idempotency_key,
             request_payload,response_payload,status
           ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'REGISTERED')
           RETURNING id`,
          [publicationId,registrationReference,idempotencyKey,JSON.stringify(payload),JSON.stringify(responsePayload)],
        );

        await client.query(
          `UPDATE frankai_registration_attempts
           SET status='REGISTERED',response_payload=$2::jsonb,registration_reference=$3,updated_at=now()
           WHERE publication_record_id=$1`,
          [publicationId,JSON.stringify(responsePayload),registrationReference],
        );

        const registrationEvidence={request:payload,response:responsePayload,registrationReference};
        const registrationObjectKey=`workspaces/${item.workspace_id}/agents/${item.registry_id}/versions/${item.version}/frankai/${record.rows[0]!.id}.json`;
        const registrationStorageBody=canonicalJson(registrationEvidence);
        const registrationStorageSha256=sha256Text(registrationStorageBody);
        const registrationArtifact=await client.query<{id:string}>(
          `INSERT INTO artifact_objects(
             workspace_id,agent_version_id,kind,object_key,sha256,media_type,byte_size
           ) VALUES ($1,$2,'FRANKAI_REGISTRATION',$3,$4,'application/json',$5)
           RETURNING id`,
          [
            item.workspace_id,item.agent_version_id,registrationObjectKey,registrationStorageSha256,
            Buffer.byteLength(registrationStorageBody),
          ],
        );
        await client.query(
          `INSERT INTO operational_jobs(workspace_id,job_type,payload)
           VALUES ($1,'STORE_ARTIFACT',$2::jsonb)`,
          [
            item.workspace_id,
            JSON.stringify({
              artifactObjectId:registrationArtifact.rows[0]!.id,
              objectKey:registrationObjectKey,
              content:registrationEvidence,
              expectedSha256:registrationStorageSha256,
            }),
          ],
        );

        await client.query(
          `UPDATE lifecycle_readiness
           SET frankai_registration_status='REGISTERED',updated_at=now()
           WHERE agent_version_id=$1`,
          [item.agent_version_id],
        );
        await client.query(
          `INSERT INTO audit_records(actor,action,target_type,target_id,evidence)
           VALUES ($1,'frankai_release_registered','frankai_registration',$2,$3::jsonb)`,
          [user.id,record.rows[0]!.id,JSON.stringify({publicationId,registrationReference,idempotencyKey})],
        );

        return {
          registrationRecordId:record.rows[0]!.id,
          publicationRecordId:publicationId,
          registrationReference,
          requestPayload:payload,
          responsePayload,
          frankaiRegistrationStatus:"REGISTERED",
          idempotentReplay:false,
        };
      });
      return json(res,201,result);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(message==="frankai_registration_already_exists") return json(res,409,{error:message});
      throw error;
    }
  }

  const authorityStateMatch=/^\/v1\/agent-versions\/([0-9a-f-]+)\/authority-state$/.exec(url.pathname);
  if(req.method==="GET" && authorityStateMatch) {
    const agentVersionId=authorityStateMatch[1]!;
    const role=await authorityRoleForAgentVersion(user.id,agentVersionId);
    if(!role) return json(res,403,{error:"insufficient_workspace_role"});

    const state=await query(
      `SELECT av.status agent_version_status,a.registry_id,av.version,
              l.certification_status,l.certification_decision_status,l.release_approval_status,
              l.release_status,l.packaging_status,l.publication_status,l.frankai_registration_status,
              c.id certification_record_id,c.decision certification_decision,c.rationale certification_rationale,
              cu.email certifier_email,cu.display_name certifier_name,c.certifier_role,
              r.id release_approval_id,r.decision release_approval_decision,r.rationale release_approval_rationale,
              r.intended_distribution,r.rights_status,
              ru.email release_approver_email,ru.display_name release_approver_name,r.approver_role
       FROM agent_versions av
       JOIN agents a ON a.id=av.agent_id
       JOIN lifecycle_readiness l ON l.agent_version_id=av.id
       LEFT JOIN certification_records c ON c.agent_version_id=av.id
       LEFT JOIN app_users cu ON cu.id=c.certifier_user_id
       LEFT JOIN release_approval_records r ON r.agent_version_id=av.id
       LEFT JOIN app_users ru ON ru.id=r.approver_user_id
       WHERE av.id=$1`,
      [agentVersionId],
    );
    if(!state.rows[0]) return json(res,404,{error:"not_found"});

    const packageRecords=await query(
      `SELECT id,release_id,package_sha256,package_location,idempotency_key,
              package_manifest,created_at::text
       FROM release_package_records WHERE agent_version_id=$1 ORDER BY created_at`,
      [agentVersionId],
    );
    const publication=await query(
      `SELECT p.id,p.channel,p.external_reference,p.idempotency_key,p.publication_payload,
              p.published_at::text,
              f.id frankai_registration_id,f.registration_reference,f.idempotency_key frankai_idempotency_key,
              f.request_payload frankai_request_payload,f.response_payload frankai_response_payload,
              f.registered_at::text
       FROM release_package_records rp
       JOIN publication_records p ON p.release_package_record_id=rp.id
       LEFT JOIN frankai_registration_records f ON f.publication_record_id=p.id
       WHERE rp.agent_version_id=$1
       ORDER BY p.published_at`,
      [agentVersionId],
    );

    return json(res,200,{
      authorityState:state.rows[0],
      releasePackages:packageRecords.rows,
      publications:publication.rows,
    });
  }

  const transformationMatch = /^\/v1\/transformations\/([0-9a-f-]+)$/.exec(url.pathname);
  if (req.method === "GET" && transformationMatch) {
    const transformationId = transformationMatch[1]!;
    const found = await query<{
      id: string; status: string; requested_name: string; requested_class: string;
      record: unknown; candidate_sha256: string | null; failure_reason: string | null;
      document: unknown | null; registry_id: string | null; version: string | null;
      provider: string | null; model: string | null; validation_status: string | null;
      agent_version_id: string | null; agent_version_status: string | null;
    }>(
      `SELECT t.id,t.status,t.requested_name,t.requested_class,t.record,t.candidate_sha256,t.failure_reason,
              t.provider,t.model,t.validation_status,t.agent_version_id,
              aps.document,a.registry_id,av.version,av.status agent_version_status
       FROM promptforge_transformations t
       JOIN projects p ON p.id=t.project_id
       JOIN workspace_memberships m ON m.workspace_id=p.workspace_id AND m.user_id=$2
       LEFT JOIN agent_versions av ON av.id=t.agent_version_id
       LEFT JOIN agents a ON a.id=av.agent_id
       LEFT JOIN aps_specifications aps ON aps.agent_version_id=av.id
       WHERE t.id=$1`,
      [transformationId, user.id],
    );
    const item = found.rows[0];
    if (!item) return json(res, 404, { error: "not_found" });
    const review = await query<{
      candidate_diff: unknown; explanation: unknown; validation: unknown;
    }>(
      `SELECT candidate_diff,explanation,validation
       FROM promptforge_review_packages WHERE transformation_id=$1`,
      [transformationId],
    );
    const stages = await query<{
      stage: string; status: string; output: unknown; sha256: string;
    }>(
      `SELECT stage,status,output,sha256
       FROM promptforge_stage_results
       WHERE transformation_id=$1
       ORDER BY created_at,stage`,
      [transformationId],
    );
    const semanticReview = item.agent_version_id ? await query<{
      id: string; decision: string; rationale: string; requested_changes: string | null;
      reviewer_user_id: string; reviewer_role: string; reviewer_email: string;
      reviewer_name: string; created_at: string;
    }>(
      `SELECT r.id,r.decision,r.rationale,r.requested_changes,r.reviewer_user_id,r.reviewer_role,
              u.email reviewer_email,u.display_name reviewer_name,r.created_at::text
       FROM semantic_reviews r
       JOIN app_users u ON u.id=r.reviewer_user_id
       WHERE r.agent_version_id=$1`,
      [item.agent_version_id],
    ) : null;

    const lifecycle = item.agent_version_id ? await query<{
      semantic_approval_status: string; evaluation_readiness_status: string;
      evaluation_status: string; certification_readiness_status: string;
      certification_status: string; release_status: string;
      certification_decision_status: string; release_approval_status: string;
      packaging_status: string; publication_status: string; frankai_registration_status: string;
    }>(
      `SELECT semantic_approval_status,evaluation_readiness_status,evaluation_status,
              certification_readiness_status,certification_status,release_status,
              certification_decision_status,release_approval_status,packaging_status,
              publication_status,frankai_registration_status
       FROM lifecycle_readiness WHERE agent_version_id=$1`,
      [item.agent_version_id],
    ) : null;

    const lineage = await query<{
      parent_transformation_id: string; child_transformation_id: string;
      parent_agent_version_id: string; child_agent_version_id: string | null;
      requested_by_review_id: string;
    }>(
      `SELECT parent_transformation_id,child_transformation_id,parent_agent_version_id,
              child_agent_version_id,requested_by_review_id
       FROM candidate_revision_lineage
       WHERE parent_transformation_id=$1 OR child_transformation_id=$1
       ORDER BY created_at`,
      [transformationId],
    );
    return json(res, 200, {
      id: item.id,
      status: item.status,
      requestedName: item.requested_name,
      requestedClass: item.requested_class,
      candidateSha256: item.candidate_sha256,
      failureReason: item.failure_reason,
      registryId: item.registry_id,
      version: item.version,
      provider: item.provider,
      model: item.model,
      validationStatus: item.validation_status,
      agentVersionStatus: item.agent_version_status,
      semanticReview: semanticReview?.rows[0] ?? null,
      lifecycle: lifecycle?.rows[0] ?? null,
      revisionLineage: lineage.rows,
      candidate: item.document,
      transformationRecord: item.record,
      reviewPackage: review.rows[0] ? {
        candidateDiff: review.rows[0].candidate_diff,
        explanation: review.rows[0].explanation,
        validation: review.rows[0].validation,
      } : null,
      stages: stages.rows,
    });
  }

  return json(res, 404, { error: "not_found" });
}

await bootstrapIdentity();

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { error: "internal_error" });
  });
});

server.listen(port, () => {
  console.log(`agent-foundry-api listening on :${port}`);
});
