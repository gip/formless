import type { AppVersion, AppVersionDetail } from './canvas-types';
import { sha256Hex } from './hash';
import { overlayHash, validateOverlay } from './project-policy';

/**
 * Server-side storage for published app versions: a single Postgres table holds
 * both the index and the overlay. It was D1 plus an R2 object per version while
 * this app deployed to Cloudflare Workers; on Vercel neither product exists, and
 * an overlay is capped at 2MB by `version-request.ts`, so it fits in a `jsonb`
 * column. Collapsing the two also makes publishing a single atomic INSERT — the
 * old code had to write the blob before the index row precisely because it
 * could not do that.
 *
 * The client is passed in rather than imported, so this module runs unchanged
 * under the node test environment against an in-memory stub — the same reason it
 * never imported `cloudflare:workers`.
 */
export interface SqlClient {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface VersionBindings {
  sql: SqlClient;
}

export const MAX_NAME_LENGTH = 60;
export const MAX_DESCRIPTION_LENGTH = 280;
export const PUBLISH_LIMIT_PER_HOUR = 20;
const LIST_LIMIT = 100;

export class VersionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'VersionError';
  }
}

interface VersionRow {
  id: string;
  name: string;
  description: string;
  content_hash: string;
  author_id: string;
  author_label: string;
  starter_hash: string;
  file_count: number;
  bytes: number;
  created_at: string;
  overlay?: { files?: unknown };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS versions (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    content_hash  TEXT NOT NULL,
    author_id     TEXT NOT NULL,
    author_label  TEXT NOT NULL,
    starter_hash  TEXT NOT NULL,
    file_count    INTEGER NOT NULL,
    bytes         INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    hidden        BOOLEAN NOT NULL DEFAULT FALSE,
    overlay       JSONB NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS versions_recent ON versions (hidden, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS publish_events (
    author_id  TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS publish_events_author ON publish_events (author_id, created_at)',
];

/**
 * `created_at` is a TEXT column holding an ISO-8601 UTC string, carried over
 * from D1 rather than converted to `timestamptz`. The rate limiter compares it
 * as a string, and ISO-8601 UTC sorts lexicographically the same way it sorts
 * chronologically, so the ordering and windowing logic is unchanged.
 */

const applied = new WeakSet<SqlClient>();

/**
 * Applies the schema once per client. Creating tables lazily is carried over
 * from the D1 setup, where a placeholder `database_id` meant migrations had
 * nothing to target; on Postgres it also means a fresh Vercel deployment works
 * against an empty database with no migration step.
 */
export async function ensureSchema(sql: SqlClient): Promise<void> {
  if (applied.has(sql)) return;
  for (const statement of SCHEMA) await sql.query(statement);
  applied.add(sql);
}

/** Never store the raw publisher token — only a digest of it. */
export function authorIdFor(token: string): Promise<string> {
  return sha256Hex(`webally-publisher/v1:${token}`);
}

/** A stable, non-identifying handle derived from the author digest. */
export function authorLabelFor(authorId: string): string {
  return `builder-${authorId.slice(0, 6)}`;
}

function newVersionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toVersion(row: VersionRow, viewerId: string | null): AppVersion {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    contentHash: row.content_hash,
    authorLabel: row.author_label,
    mine: viewerId !== null && row.author_id === viewerId,
    starterHash: row.starter_hash,
    fileCount: row.file_count,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}

export function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new VersionError('A version name is required.', 400);
  if (name.length > MAX_NAME_LENGTH) {
    throw new VersionError(`A version name may be at most ${MAX_NAME_LENGTH} characters.`, 400);
  }
  return name;
}

export function normalizeDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new VersionError('description must be a string.', 400);
  const description = value.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new VersionError(`A description may be at most ${MAX_DESCRIPTION_LENGTH} characters.`, 400);
  }
  return description;
}

export async function listVersions(bindings: VersionBindings, viewerId: string | null): Promise<AppVersion[]> {
  await ensureSchema(bindings.sql);
  // The overlay column is deliberately not selected: listing every version
  // would otherwise pull up to 2MB of source per row to render a dropdown.
  const { rows } = await bindings.sql.query<VersionRow>(
    `SELECT id, name, description, content_hash, author_id, author_label,
            starter_hash, file_count, bytes, created_at
       FROM versions WHERE hidden = FALSE ORDER BY created_at DESC LIMIT $1`,
    [LIST_LIMIT],
  );
  return rows.map((row) => toVersion(row, viewerId));
}

export async function getVersion(
  bindings: VersionBindings,
  id: string,
  viewerId: string | null,
): Promise<AppVersionDetail | null> {
  await ensureSchema(bindings.sql);
  const { rows } = await bindings.sql.query<VersionRow>(
    'SELECT * FROM versions WHERE id = $1 AND hidden = FALSE',
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.overlay) throw new VersionError('The stored version payload is missing.', 502);
  // Re-validate on the way out: the overlay allowlist is enforced at both ends,
  // so a row written by an older or looser build still cannot widen the surface.
  return { ...toVersion(row, viewerId), files: validateOverlay(row.overlay.files) };
}

async function assertUnderPublishLimit(bindings: VersionBindings, authorId: string): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { rows } = await bindings.sql.query<{ count: string | number }>(
    'SELECT COUNT(*) AS count FROM publish_events WHERE author_id = $1 AND created_at > $2',
    [authorId, since],
  );
  // Postgres returns COUNT(*) as bigint, which pg surfaces as a string.
  if (Number(rows[0]?.count ?? 0) >= PUBLISH_LIMIT_PER_HOUR) {
    throw new VersionError('Publish rate limit reached. Try again in an hour.', 429);
  }
}

export interface PublishInput {
  authorId: string;
  name: unknown;
  description?: unknown;
  starterHash: unknown;
  files: unknown;
}

export async function publishVersion(bindings: VersionBindings, input: PublishInput): Promise<AppVersion> {
  await ensureSchema(bindings.sql);
  const name = normalizeName(input.name);
  const description = normalizeDescription(input.description);
  const files = validateOverlay(input.files);
  if (Object.keys(files).length === 0) {
    throw new VersionError('A version must contain at least one editable file.', 400);
  }
  if (typeof input.starterHash !== 'string' || !/^[0-9a-f]{16}$/.test(input.starterHash)) {
    throw new VersionError('starterHash must be a 16-character hex fingerprint.', 400);
  }
  await assertUnderPublishLimit(bindings, input.authorId);

  const body = JSON.stringify({ files });
  const row: VersionRow = {
    id: newVersionId(),
    name,
    description,
    content_hash: await overlayHash(files),
    author_id: input.authorId,
    author_label: authorLabelFor(input.authorId),
    starter_hash: input.starterHash,
    file_count: Object.keys(files).length,
    bytes: new TextEncoder().encode(body).byteLength,
    created_at: new Date().toISOString(),
  };

  // One INSERT carries both the index columns and the overlay, so a version is
  // never half-written. Under D1 + R2 this had to be two writes, blob first,
  // because an index row pointing at a missing object was a broken version in
  // everyone's header.
  await bindings.sql.query(
    `INSERT INTO versions
      (id, name, description, content_hash, author_id, author_label, starter_hash, file_count, bytes, created_at, hidden, overlay)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, $11)`,
    [
      row.id, row.name, row.description, row.content_hash, row.author_id,
      row.author_label, row.starter_hash, row.file_count, row.bytes, row.created_at, body,
    ],
  );
  await bindings.sql.query(
    'INSERT INTO publish_events (author_id, created_at) VALUES ($1, $2)',
    [row.author_id, row.created_at],
  );

  return toVersion(row, input.authorId);
}

async function loadOwnedRow(bindings: VersionBindings, id: string, authorId: string): Promise<VersionRow> {
  await ensureSchema(bindings.sql);
  const { rows } = await bindings.sql.query<VersionRow>(
    `SELECT id, name, description, content_hash, author_id, author_label,
            starter_hash, file_count, bytes, created_at
       FROM versions WHERE id = $1 AND hidden = FALSE`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new VersionError('Unknown version.', 404);
  if (row.author_id !== authorId) throw new VersionError('This version belongs to someone else.', 403);
  return row;
}

export async function updateVersion(
  bindings: VersionBindings,
  id: string,
  authorId: string,
  patch: { name?: unknown; description?: unknown },
): Promise<AppVersion> {
  const row = await loadOwnedRow(bindings, id, authorId);
  const name = patch.name === undefined ? row.name : normalizeName(patch.name);
  const description = patch.description === undefined ? row.description : normalizeDescription(patch.description);
  await bindings.sql.query(
    'UPDATE versions SET name = $1, description = $2 WHERE id = $3',
    [name, description, id],
  );
  return toVersion({ ...row, name, description }, authorId);
}

/**
 * Unpublish hides the row and drops the overlay. The row stays so a version id
 * that is still open in someone's tab resolves to a clean 404 rather than
 * being reused by a later publish; clearing `overlay` is what actually deletes
 * the published source, which was the R2 delete before.
 */
export async function hideVersion(bindings: VersionBindings, id: string, authorId: string): Promise<void> {
  await loadOwnedRow(bindings, id, authorId);
  await bindings.sql.query(
    `UPDATE versions SET hidden = TRUE, overlay = '{"files":{}}'::jsonb WHERE id = $1`,
    [id],
  );
}
