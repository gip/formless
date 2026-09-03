import { beforeEach, describe, expect, it } from 'vitest';
import {
  errorResponse,
  optionalAuthorId,
  readJsonBody,
  requireAuthorId,
  requireBindings,
} from '../lib/version-request';
import {
  authorIdFor,
  getVersion,
  hideVersion,
  listVersions,
  publishVersion,
  PUBLISH_LIMIT_PER_HOUR,
  updateVersion,
  VersionError,
  type SqlClient,
  type VersionBindings,
} from '../lib/version-store';

/**
 * The Postgres stub understands exactly the statements `version-store.ts`
 * issues. The point is to exercise ownership, rate limiting, validation, and
 * atomicity — not to reimplement Postgres.
 */
interface Row { [column: string]: unknown }

/** Columns `listVersions` and `loadOwnedRow` select; overlay is excluded. */
const INDEX_COLUMNS = [
  'id', 'name', 'description', 'content_hash', 'author_id',
  'author_label', 'starter_hash', 'file_count', 'bytes', 'created_at',
];

function withoutOverlay(row: Row): Row {
  return Object.fromEntries(INDEX_COLUMNS.map((column) => [column, row[column]]));
}

function makeSql() {
  const versions: Row[] = [];
  const publishEvents: Row[] = [];

  async function query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    const rows = (() => {
      if (text.startsWith('CREATE')) return [];

      if (text.includes('FROM versions WHERE hidden = FALSE ORDER BY')) {
        return versions
          .filter((row) => row.hidden === false)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, Number(params[0]))
          .map(withoutOverlay);
      }
      if (text.startsWith('SELECT * FROM versions WHERE id = $1 AND hidden = FALSE')) {
        const row = versions.find((candidate) => candidate.id === params[0] && candidate.hidden === false);
        return row ? [row] : [];
      }
      if (text.includes('FROM versions WHERE id = $1 AND hidden = FALSE')) {
        const row = versions.find((candidate) => candidate.id === params[0] && candidate.hidden === false);
        return row ? [withoutOverlay(row)] : [];
      }
      if (text.startsWith('SELECT COUNT(*) AS count FROM publish_events')) {
        const count = publishEvents.filter(
          (event) => event.author_id === params[0] && String(event.created_at) > String(params[1]),
        ).length;
        // pg surfaces bigint COUNT(*) as a string; the store must cope.
        return [{ count: String(count) }];
      }
      if (text.startsWith('INSERT INTO versions')) {
        const [id, name, description, contentHash, authorId, authorLabel,
               starterHash, fileCount, bytes, createdAt, overlay] = params;
        versions.push({
          id, name, description, content_hash: contentHash, author_id: authorId,
          author_label: authorLabel, starter_hash: starterHash, file_count: fileCount,
          bytes, created_at: createdAt, hidden: false,
          overlay: JSON.parse(String(overlay)) as unknown,
        });
        return [];
      }
      if (text.startsWith('INSERT INTO publish_events')) {
        publishEvents.push({ author_id: params[0], created_at: params[1] });
        return [];
      }
      if (text.startsWith('UPDATE versions SET name')) {
        const row = versions.find((candidate) => candidate.id === params[2]);
        if (row) { row.name = params[0]; row.description = params[1]; }
        return [];
      }
      if (text.startsWith('UPDATE versions SET hidden = TRUE')) {
        const row = versions.find((candidate) => candidate.id === params[0]);
        if (row) { row.hidden = true; row.overlay = { files: {} }; }
        return [];
      }
      throw new Error(`Unhandled statement: ${text}`);
    })();
    return { rows: rows as T[] };
  }

  return { sql: { query } satisfies SqlClient, versions };
}

const overlay = { 'src/App.tsx': 'export default function App() { return null; }' };
const STARTER_HASH = '1111222233334444';

let bindings: VersionBindings;
let versions: { [column: string]: unknown }[];
let author: string;
let other: string;

beforeEach(async () => {
  const database = makeSql();
  bindings = { sql: database.sql };
  versions = database.versions;
  author = await authorIdFor('token-aaaaaaaaaaaaaaaa');
  other = await authorIdFor('token-bbbbbbbbbbbbbbbb');
});

function publish(overrides: Partial<Parameters<typeof publishVersion>[1]> = {}) {
  return publishVersion(bindings, {
    authorId: author, name: 'Dark dashboard', starterHash: STARTER_HASH, files: overlay, ...overrides,
  });
}

describe('publishing', () => {
  it('stores the overlay and indexes it', async () => {
    const version = await publish({ description: '  High contrast  ' });
    expect(version.id).toMatch(/^[0-9a-f]{16}$/);
    expect(version.name).toBe('Dark dashboard');
    expect(version.description).toBe('High contrast');
    expect(version.mine).toBe(true);
    expect(version.authorLabel).toBe(`builder-${author.slice(0, 6)}`);
    expect(version.fileCount).toBe(1);
    expect(versions).toHaveLength(1);

    const detail = await getVersion(bindings, version.id, author);
    expect(detail?.files).toEqual(overlay);
    expect(detail?.mine).toBe(true);
  });

  it('derives the author id from the token without storing it', async () => {
    const version = await publish();
    expect(JSON.stringify(version)).not.toContain('token-aaaaaaaaaaaaaaaa');
    const seenByOther = await getVersion(bindings, version.id, other);
    expect(seenByOther?.mine).toBe(false);
    const anonymous = await getVersion(bindings, version.id, null);
    expect(anonymous?.mine).toBe(false);
  });

  it('refuses protected paths, empty overlays, and bad metadata', async () => {
    await expect(publish({ files: { 'src/agent/bridge.tsx': 'x' } })).rejects.toThrow(/Protected/);
    await expect(publish({ files: {} })).rejects.toThrow(/at least one/);
    await expect(publish({ name: '   ' })).rejects.toThrow(/name is required/);
    await expect(publish({ name: 'x'.repeat(61) })).rejects.toThrow(/at most/);
    await expect(publish({ description: 'x'.repeat(281) })).rejects.toThrow(/at most/);
    await expect(publish({ starterHash: 'nope' })).rejects.toThrow(/hex fingerprint/);
    // Every rejection happens before the INSERT, so nothing is half-written.
    expect(versions).toEqual([]);
  });

  it('rate limits a single author', async () => {
    for (let index = 0; index < PUBLISH_LIMIT_PER_HOUR; index += 1) await publish();
    await expect(publish()).rejects.toMatchObject({ status: 429 });
    // A different publisher is unaffected.
    await expect(publish({ authorId: other })).resolves.toBeTruthy();
  });
});

describe('listing, renaming and unpublishing', () => {
  it('lists newest first and marks the viewer\'s own versions', async () => {
    const mine = await publish({ name: 'Mine' });
    const theirs = await publish({ authorId: other, name: 'Theirs' });
    const listed = await listVersions(bindings, author);
    expect(listed.map((version) => version.name).sort()).toEqual(['Mine', 'Theirs']);
    expect(listed.find((version) => version.id === mine.id)?.mine).toBe(true);
    expect(listed.find((version) => version.id === theirs.id)?.mine).toBe(false);
  });

  it('only lets the owner rename or unpublish', async () => {
    const version = await publish();
    await expect(updateVersion(bindings, version.id, other, { name: 'Hijacked' }))
      .rejects.toMatchObject({ status: 403 });
    await expect(hideVersion(bindings, version.id, other)).rejects.toMatchObject({ status: 403 });

    const renamed = await updateVersion(bindings, version.id, author, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    expect(renamed.description).toBe('');

    await hideVersion(bindings, version.id, author);
    expect(await getVersion(bindings, version.id, author)).toBeNull();
    expect(await listVersions(bindings, author)).toEqual([]);
    // The published source is gone, but the row stays so the id is not reusable.
    expect(versions).toHaveLength(1);
    expect(versions[0].overlay).toEqual({ files: {} });
    await expect(updateVersion(bindings, version.id, author, { name: 'Back' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('reports a missing overlay rather than serving a half-broken version', async () => {
    const version = await publish();
    // Only reachable via a row written outside this code path: publishing is a
    // single INSERT now, so the store cannot produce this state itself.
    versions[0].overlay = undefined;
    await expect(getVersion(bindings, version.id, author)).rejects.toMatchObject({ status: 502 });
  });
});

describe('request plumbing', () => {
  function request(headers: Record<string, string> = {}, body?: string) {
    return new Request('https://example.test/api/versions', {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body,
    });
  }

  it('answers 503 when the bindings are not configured', () => {
    expect(() => requireBindings({})).toThrow(VersionError);
    try {
      requireBindings({});
    } catch (error) {
      expect((error as VersionError).status).toBe(503);
      expect(errorResponse(error).status).toBe(503);
    }
    expect(requireBindings({ POSTGRES_URL: 'postgres://user@localhost/db' })).toBeTruthy();
  });

  it('accepts only well-formed bearer tokens', async () => {
    await expect(requireAuthorId(request())).rejects.toMatchObject({ status: 401 });
    await expect(requireAuthorId(request({ authorization: 'Bearer short' }))).rejects.toMatchObject({ status: 401 });
    await expect(requireAuthorId(request({ authorization: 'Basic abcdefghijklmnop' }))).rejects.toMatchObject({ status: 401 });
    expect(await optionalAuthorId(request())).toBeNull();
    expect(await requireAuthorId(request({ authorization: 'Bearer token-aaaaaaaaaaaaaaaa' }))).toBe(author);
  });

  it('rejects non-object and malformed bodies', async () => {
    await expect(readJsonBody(request({}, 'not json'))).rejects.toMatchObject({ status: 400 });
    await expect(readJsonBody(request({}, '[1,2]'))).rejects.toMatchObject({ status: 400 });
    expect(await readJsonBody(request({}, '{"name":"x"}'))).toEqual({ name: 'x' });
  });

  it('maps unexpected failures to a 400 instead of leaking a stack', () => {
    const response = errorResponse(new Error('boom'));
    expect(response.status).toBe(400);
  });
});
