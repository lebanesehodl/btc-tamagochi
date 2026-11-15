import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export async function migrate(pool: Pool, directory = path.resolve(process.cwd(), "migrations")): Promise<void> {
  const connection = await pool.connect();
  try {
    await connection.query("SELECT pg_advisory_lock(743901)");
    await connection.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const migrations = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const version of migrations) {
      const sql = await fs.readFile(path.join(directory, version), "utf8");
      const sha256 = crypto.createHash("sha256").update(sql).digest("hex");
      await connection.query("BEGIN");
      try {
        const existing = await connection.query("SELECT sha256 FROM schema_migrations WHERE version = $1", [version]);
        if (existing.rows[0] && existing.rows[0].sha256 !== sha256) {
          throw new Error(`Applied migration ${version} changed on disk`);
        }
        if (!existing.rows[0]) {
          await connection.query(sql);
          await connection.query("INSERT INTO schema_migrations(version, sha256) VALUES ($1, $2)", [version, sha256]);
        }
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await connection.query("SELECT pg_advisory_unlock(743901)");
    connection.release();
  }
}
