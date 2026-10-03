import { hashPassword, normalizeEmail } from "@agent-foundry/auth";
import { query } from "@agent-foundry/db";
import { slugify } from "@agent-foundry/domain";

export async function bootstrapIdentity() {
  const emailRaw = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const workspaceName = process.env.BOOTSTRAP_WORKSPACE_NAME ?? "Default Workspace";
  if (!emailRaw || !password) return;

  const email = normalizeEmail(emailRaw);
  const existing = await query<{ id: string }>("SELECT id FROM app_users WHERE email=$1", [email]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const passwordHash = await hashPassword(password);
    const created = await query<{ id: string }>(
      "INSERT INTO app_users(email,display_name,password_hash) VALUES ($1,$2,$3) RETURNING id",
      [email, email.split("@")[0] ?? "Admin", passwordHash],
    );
    userId = created.rows[0]!.id;
  }

  const workspaceSlug = slugify(workspaceName);
  const ws = await query<{ id: string }>(
    `INSERT INTO workspaces(slug,name) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name
     RETURNING id`,
    [workspaceSlug, workspaceName],
  );
  const workspaceId = ws.rows[0]!.id;

  await query(
    `INSERT INTO workspace_memberships(workspace_id,user_id,role)
     VALUES ($1,$2,'OWNER')
     ON CONFLICT (workspace_id,user_id) DO NOTHING`,
    [workspaceId, userId],
  );

  await query(
    `INSERT INTO projects(workspace_id,slug,name)
     VALUES ($1,'default','Default Project')
     ON CONFLICT (workspace_id,slug) DO NOTHING`,
    [workspaceId],
  );
}
