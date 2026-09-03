import { Pool } from 'pg';
import type { SqlClient, VersionBindings } from './version-store';

/**
 * The Postgres connection, kept out of `version-store.ts` so that module stays
 * driver-free and runs unchanged under the node test environment against an
 * in-memory stub — the same reason it never imported `cloudflare:workers` when
 * this app ran on Workers.
 *
 * Pools are memoized per connection string because serverless functions are
 * re-invoked on a warm module: creating a Pool per request is how you exhaust a
 * Postgres connection limit. Point `POSTGRES_URL` at a pooled endpoint (Neon's
 * `-pooler` host, Supabase's pgBouncer port) rather than the direct one.
 */

const pools = new Map<string, Pool>();

function getPool(connectionString: string): SqlClient {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
    // Without a listener an idle client error takes the whole process down.
    pool.on('error', () => {});
    pools.set(connectionString, pool);
  }
  return pool;
}

/**
 * Returns null when no database is configured, so callers answer 503 instead of
 * throwing — a deployment without one still serves the app, it just cannot list
 * or publish versions. Same posture as `fetchRuntimeSnapshot()`.
 */
export function resolveBindings(env: Record<string, unknown>): VersionBindings | null {
  const url = env.POSTGRES_URL ?? env.DATABASE_URL;
  if (typeof url !== 'string' || !url) return null;
  return { sql: getPool(url) };
}
