import type { Pool } from "pg";

export interface WorkerLease {
  owner: string;
  fencingToken: number;
}

export async function acquireWorkerLease(
  pool: Pool,
  owner: string,
  name = "blocks",
  leaseMs = 30_000,
): Promise<WorkerLease | null> {
  const result = await pool.query(
    `INSERT INTO worker_leases(name, owner, fencing_token, expires_at)
     VALUES ($1, $2, 1, now() + make_interval(secs => $3 / 1000.0))
     ON CONFLICT(name) DO UPDATE SET
       owner = EXCLUDED.owner,
       fencing_token = worker_leases.fencing_token + 1,
       expires_at = now() + make_interval(secs => $3 / 1000.0)
     WHERE worker_leases.owner = EXCLUDED.owner OR worker_leases.expires_at <= now()
     RETURNING fencing_token`,
    [name, owner, leaseMs],
  );
  const row = result.rows[0];
  return row ? { owner, fencingToken: Number(row.fencing_token) } : null;
}

export async function leaseIsCurrent(
  pool: Pool,
  lease: WorkerLease,
  name = "blocks",
): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM worker_leases WHERE name = $1 AND owner = $2 AND fencing_token = $3 AND expires_at > now()",
    [name, lease.owner, lease.fencingToken],
  );
  return result.rowCount === 1;
}
