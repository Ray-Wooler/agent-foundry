import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { digestSessionToken, issueSessionToken, normalizeEmail, verifyPassword } from "@agent-foundry/auth";
import { query, transaction } from "@agent-foundry/db";
import { sha256Text, type RightsStatus } from "@agent-foundry/domain";
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

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const db = await query<{ now: string }>("SELECT now()::text AS now");
    return json(res, 200, { status: "ok", service: "agent-foundry-api", database: db.rows[0]?.now });
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

  const transformationMatch = /^\/v1\/transformations\/([0-9a-f-]+)$/.exec(url.pathname);
  if (req.method === "GET" && transformationMatch) {
    const transformationId = transformationMatch[1]!;
    const found = await query<{
      id: string; status: string; requested_name: string; requested_class: string;
      record: unknown; candidate_sha256: string | null; failure_reason: string | null;
      document: unknown | null; registry_id: string | null; version: string | null;
      provider: string | null; model: string | null; validation_status: string | null;
    }>(
      `SELECT t.id,t.status,t.requested_name,t.requested_class,t.record,t.candidate_sha256,t.failure_reason,
              t.provider,t.model,t.validation_status,
              aps.document,a.registry_id,av.version
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
