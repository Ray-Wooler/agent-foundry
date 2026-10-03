import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDir = process.env.MIGRATIONS_DIR ?? path.join(repositoryRoot, "migrations");

await pool.query(`
  CREATE TABLE IF NOT EXISTS app_schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const files = (await readdir(migrationsDir))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();

for (const filename of files) {
  const existing = await pool.query(
    "SELECT 1 FROM app_schema_migrations WHERE filename = $1",
    [filename],
  );
  if (existing.rowCount) continue;

  const sql = await readFile(path.join(migrationsDir, filename), "utf8");
  await pool.query(sql);
  await pool.query("INSERT INTO app_schema_migrations(filename) VALUES ($1)", [filename]);
  console.log(`applied ${filename}`);
}

await pool.end();
