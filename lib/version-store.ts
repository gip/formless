import type { AppVersion, AppVersionDetail } from './canvas-types';
import { sha256Hex } from './hash';
import { overlayHash, validateOverlay } from './project-policy';

/**
 * Server-side storage for published app versions: D1 holds the index, R2 holds
 * the overlay blob. Bindings are passed in rather than imported from
 * `cloudflare:workers`, so this module runs unchanged under the node test
 * environment against in-memory stubs.
 */
export interface VersionBindings {
  db: D1Database;
  bucket: R2Bucket;
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
}

/**
 * Reads the binding names configured in `.openai/hosting.json`. Returns null
 * when either binding is missing so callers can answer 503 instead of throwing
 * — a deployment without a backend still serves the app, it just cannot list
 * or publish versions.
 */
export function resolveBindings(env: Record<string, unknown>): VersionBindings | null {
  const db = env.DB as D1Database | undefined;
  const bucket = env.VERSIONS as R2Bucket | undefined;
  if (!db || typeof db.prepare !== 'function') return null;
  if (!bucket || typeof bucket.get !== 'function') return null;
  return { db, bucket };
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
    hidden        INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS versions_recent ON versions (hidden, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS publish_events (
    author_id  TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS publish_events_author ON publish_events (author_id, created_at)',
];

const applied = new WeakSet<D1Database>();

/**
 * Applies the schema once per isolate. `vite.config.ts` pins a placeholder
 * `database_id`, so there is no real database for `wrangler d1 migrations` to
 * target; creating tables lazily keeps local Miniflare and a deployed D1 on the
 * same path.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (applied.has(db)) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  applied.add(db);
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

function objectKey(id: string): string {
  return `versions/${id}.json`;
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
  await ensureSchema(bindings.db);
  const { results } = await bindings.db
    .prepare('SELECT * FROM versions WHERE hidden = 0 ORDER BY created_at DESC LIMIT ?1')
    .bind(LIST_LIMIT)
    .all<VersionRow>();
  return (results ?? []).map((row) => toVersion(row, viewerId));
}

export async function getVersion(
  bindings: VersionBindings,
  id: string,
  viewerId: string | null,
): Promise<AppVersionDetail | null> {
  await ensureSchema(bindings.db);
  const row = await bindings.db
    .prepare('SELECT * FROM versions WHERE id = ?1 AND hidden = 0')
    .bind(id)
    .first<VersionRow>();
  if (!row) return null;

  const object = await bindings.bucket.get(objectKey(id));
  if (!object) throw new VersionError('The stored version payload is missing.', 502);
  const payload = (await object.json()) as { files?: unknown };
  // Re-validate on the way out: the overlay allowlist is enforced at both ends,
  // so a row written by an older or looser build still cannot widen the surface.
  return { ...toVersion(row, viewerId), files: validateOverlay(payload.files) };
}

async function assertUnderPublishLimit(bindings: VersionBindings, authorId: string): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await bindings.db
    .prepare('SELECT COUNT(*) AS count FROM publish_events WHERE author_id = ?1 AND created_at > ?2')
    .bind(authorId, since)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= PUBLISH_LIMIT_PER_HOUR) {
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
  await ensureSchema(bindings.db);
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

  // Blob first: an orphaned object is harmless, an index row pointing at a
  // missing object is a broken version in everyone's header.
  await bindings.bucket.put(objectKey(row.id), body, {
    httpMetadata: { contentType: 'application/json' },
  });
  await bindings.db
    .prepare(`INSERT INTO versions
      (id, name, description, content_hash, author_id, author_label, starter_hash, file_count, bytes, created_at, hidden)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)`)
    .bind(
      row.id, row.name, row.description, row.content_hash, row.author_id,
      row.author_label, row.starter_hash, row.file_count, row.bytes, row.created_at,
    )
    .run();
  await bindings.db
    .prepare('INSERT INTO publish_events (author_id, created_at) VALUES (?1, ?2)')
    .bind(row.author_id, row.created_at)
    .run();

  return toVersion(row, input.authorId);
}

async function loadOwnedRow(bindings: VersionBindings, id: string, authorId: string): Promise<VersionRow> {
  await ensureSchema(bindings.db);
  const row = await bindings.db
    .prepare('SELECT * FROM versions WHERE id = ?1 AND hidden = 0')
    .bind(id)
    .first<VersionRow>();
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
  await bindings.db
    .prepare('UPDATE versions SET name = ?1, description = ?2 WHERE id = ?3')
    .bind(name, description, id)
    .run();
  return toVersion({ ...row, name, description }, authorId);
}

/**
 * Unpublish hides the row and drops the blob. The row stays so a version id
 * that is still open in someone's tab resolves to a clean 404 rather than
 * being reused by a later publish.
 */
export async function hideVersion(bindings: VersionBindings, id: string, authorId: string): Promise<void> {
  await loadOwnedRow(bindings, id, authorId);
  await bindings.db.prepare('UPDATE versions SET hidden = 1 WHERE id = ?1').bind(id).run();
  await bindings.bucket.delete(objectKey(id));
}
