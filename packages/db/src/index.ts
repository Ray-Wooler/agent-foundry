import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { canonicalJson, sha256Text } from "@agent-foundry/domain";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({ connectionString });

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
) {
  return pool.query<T>(text, [...values]);
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  await pool.end();
}


export type PersistedAuthorityDecision = {
  decisionId: string;
  status: "ALLOW" | "REQUIRES_APPROVAL" | "DENY";
  evidence: {
    decisionStatus: "ALLOW" | "REQUIRES_APPROVAL" | "DENY";
    resolverVersion: string;
    contractSha256: string;
    taskId: string;
    planId: string;
    sessionId: string | null;
    [key: string]: unknown;
  };
};

export async function persistAuthorityDecisionRecord(
  decision: PersistedAuthorityDecision,
): Promise<{ decisionId: string; evidenceSha256: string; inserted: boolean }> {
  const evidenceSha256 = sha256Text(canonicalJson(decision.evidence));
  if (decision.evidence.decisionStatus !== decision.status) {
    throw new Error("authority decision status does not match canonical evidence");
  }
  if (evidenceSha256 !== decision.decisionId) {
    throw new Error("authority decision id does not match canonical evidence");
  }
  const result = await query<{ decision_id: string }>(
    `INSERT INTO authority_decision_records(
       decision_id,resolver_version,decision_status,task_id,plan_id,session_id,
       contract_sha256,evidence,evidence_sha256
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (decision_id) DO NOTHING
     RETURNING decision_id`,
    [
      decision.decisionId,
      decision.evidence.resolverVersion,
      decision.status,
      decision.evidence.taskId,
      decision.evidence.planId,
      decision.evidence.sessionId,
      decision.evidence.contractSha256,
      JSON.stringify(decision.evidence),
      evidenceSha256,
    ],
  );
  if (result.rowCount) {
    return { decisionId: decision.decisionId, evidenceSha256, inserted: true };
  }

  const existing = await query<{
    resolver_version: string;
    decision_status: string;
    task_id: string;
    plan_id: string;
    session_id: string | null;
    contract_sha256: string;
    evidence_sha256: string;
  }>(
    `SELECT resolver_version,decision_status,task_id,plan_id,session_id,
            contract_sha256,evidence_sha256
     FROM authority_decision_records
     WHERE decision_id=$1`,
    [decision.decisionId],
  );
  const row = existing.rows[0];
  if (!row
    || row.resolver_version !== decision.evidence.resolverVersion
    || row.decision_status !== decision.status
    || row.task_id !== decision.evidence.taskId
    || row.plan_id !== decision.evidence.planId
    || row.session_id !== decision.evidence.sessionId
    || row.contract_sha256 !== decision.evidence.contractSha256
    || row.evidence_sha256 !== evidenceSha256) {
    throw new Error("authority decision persistence conflict");
  }
  return { decisionId: decision.decisionId, evidenceSha256, inserted: false };
}

export type PersistedCapabilityToken = {
  token: string;
  tokenSha256: string;
  payload: {
    version: "1.0";
    issuer: "agent-foundry";
    algorithm: "EdDSA";
    keyId: string;
    tokenId: string;
    decisionId: string;
    contractSha256: string;
    taskId: string;
    planId: string;
    sessionId: string | null;
    roleIds: string[];
    capabilities: string[];
    issuedAt: string;
    expiresAt: string;
  };
};

export async function persistCapabilityTokenRecord(
  issued: PersistedCapabilityToken,
): Promise<{ tokenId: string; inserted: boolean }> {
  if (sha256Text(issued.token) !== issued.tokenSha256) {
    throw new Error("capability token hash does not match bearer token");
  }
  const decision = await query<{ decision_status: string }>(
    `SELECT decision_status
     FROM authority_decision_records
     WHERE decision_id=$1`,
    [issued.payload.decisionId],
  );
  if (decision.rows[0]?.decision_status !== "ALLOW") {
    throw new Error("capability token persistence requires persisted ALLOW decision");
  }

  const result = await query<{ token_id: string }>(
    `INSERT INTO capability_token_records(
       token_id,decision_id,token_sha256,token_version,issuer,algorithm,key_id,
       task_id,plan_id,session_id,contract_sha256,role_ids,capabilities,issued_at,expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)
     ON CONFLICT (token_sha256) DO NOTHING
     RETURNING token_id`,
    [
      issued.payload.tokenId,
      issued.payload.decisionId,
      issued.tokenSha256,
      issued.payload.version,
      issued.payload.issuer,
      issued.payload.algorithm,
      issued.payload.keyId,
      issued.payload.taskId,
      issued.payload.planId,
      issued.payload.sessionId,
      issued.payload.contractSha256,
      JSON.stringify(issued.payload.roleIds),
      JSON.stringify(issued.payload.capabilities),
      issued.payload.issuedAt,
      issued.payload.expiresAt,
    ],
  );
  if (result.rowCount) return { tokenId: result.rows[0]!.token_id, inserted: true };

  const existing = await query<{
    token_id: string;
    decision_id: string;
    token_version: string;
    issuer: string;
    algorithm: string;
    key_id: string;
    task_id: string;
    plan_id: string;
    session_id: string | null;
    contract_sha256: string;
    role_ids: string[];
    capabilities: string[];
    issued_at: string;
    expires_at: string;
  }>(
    `SELECT token_id,decision_id,token_version,issuer,algorithm,key_id,
            task_id,plan_id,session_id,contract_sha256,role_ids,capabilities,
            issued_at::text,expires_at::text
     FROM capability_token_records
     WHERE token_sha256=$1`,
    [issued.tokenSha256],
  );
  const row = existing.rows[0];
  if (!row
    || row.token_id !== issued.payload.tokenId
    || row.decision_id !== issued.payload.decisionId
    || row.token_version !== issued.payload.version
    || row.issuer !== issued.payload.issuer
    || row.algorithm !== issued.payload.algorithm
    || row.key_id !== issued.payload.keyId
    || row.task_id !== issued.payload.taskId
    || row.plan_id !== issued.payload.planId
    || row.session_id !== issued.payload.sessionId
    || row.contract_sha256 !== issued.payload.contractSha256
    || JSON.stringify(row.role_ids) !== JSON.stringify(issued.payload.roleIds)
    || JSON.stringify(row.capabilities) !== JSON.stringify(issued.payload.capabilities)
    || Date.parse(row.issued_at) !== Date.parse(issued.payload.issuedAt)
    || Date.parse(row.expires_at) !== Date.parse(issued.payload.expiresAt)) {
    throw new Error("capability token persistence conflict");
  }
  return { tokenId: row.token_id, inserted: false };
}

export async function getCapabilityTokenState(tokenSha256: string): Promise<{
  tokenId: string;
  decisionId: string;
  taskId: string;
  planId: string;
  sessionId: string | null;
  contractSha256: string;
  roleIds: string[];
  capabilities: string[];
  keyId: string;
  algorithm: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
} | null> {
  const result = await query<{
    token_id: string;
    decision_id: string;
    task_id: string;
    plan_id: string;
    session_id: string | null;
    contract_sha256: string;
    role_ids: string[];
    capabilities: string[];
    key_id: string;
    algorithm: string;
    issued_at: string;
    expires_at: string;
    revoked_at: string | null;
    revocation_reason: string | null;
  }>(
    `SELECT token_id,decision_id,task_id,plan_id,session_id,contract_sha256,
            role_ids,capabilities,key_id,algorithm,issued_at::text,
            expires_at::text,revoked_at::text,revocation_reason
     FROM capability_token_records
     WHERE token_sha256=$1`,
    [tokenSha256],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    tokenId: row.token_id,
    decisionId: row.decision_id,
    taskId: row.task_id,
    planId: row.plan_id,
    sessionId: row.session_id,
    contractSha256: row.contract_sha256,
    roleIds: row.role_ids,
    capabilities: row.capabilities,
    keyId: row.key_id,
    algorithm: row.algorithm,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  };
}

export async function revokeCapabilityToken(
  tokenSha256: string,
  reason: string,
): Promise<{ revoked: boolean; revokedAt: string | null }> {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3) throw new Error("capability token revocation reason required");

  const result = await query<{ revoked_at: string }>(
    `UPDATE capability_token_records
     SET revoked_at=now(),revocation_reason=$2
     WHERE token_sha256=$1 AND revoked_at IS NULL
     RETURNING revoked_at::text`,
    [tokenSha256, normalizedReason],
  );
  if (result.rowCount) return { revoked: true, revokedAt: result.rows[0]!.revoked_at };

  const existing = await query<{ revoked_at: string | null }>(
    "SELECT revoked_at::text FROM capability_token_records WHERE token_sha256=$1",
    [tokenSha256],
  );
  if (!existing.rowCount) throw new Error("capability token not found");
  return { revoked: false, revokedAt: existing.rows[0]!.revoked_at };
}
