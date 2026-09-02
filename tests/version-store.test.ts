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
  type VersionBindings,
} from '../lib/version-store';

/**
 * The D1 stub understands exactly the statements `version-store.ts` issues.
 * The point is to exercise ownership, rate limiting, validation, and the
 * blob/index write order — not to reimplement SQLite.
 */
interface Row { [column: string]: string | number }

function makeDb() {
  const versions: Row[] = [];
  const publishEvents: Row[] = [];

  function run(sql: string, args: (string | number)[]) {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('CREATE')) return { rows: [], first: null };

    if (text.startsWith('SELECT * FROM versions WHERE hidden = 0 ORDER BY')) {
      const rows = versions
        .filter((row) => row.hidden === 0)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Number(args[0]));
      return { rows, first: rows[0] ?? null };
    }
    if (text.startsWith('SELECT * FROM versions WHERE id = ?1 AND hidden = 0')) {
      const row = versions.find((candidate) => candidate.id === args[0] && candidate.hidden === 0) ?? null;
      return { rows: row ? [row] : [], first: row };
    }
    if (text.startsWith('SELECT COUNT(*) AS count FROM publish_events')) {
      const count = publishEvents.filter(
        (event) => event.author_id === args[0] && String(event.created_at) > String(args[1]),
      ).length;
      return { rows: [{ count }], first: { count } };
    }
    if (text.startsWith('INSERT INTO versions')) {
      const [id, name, description, contentHash, authorId, authorLabel, starterHash, fileCount, bytes, createdAt] = args;
      versions.push({
        id, name, description, content_hash: contentHash, author_id: authorId, author_label: authorLabel,
        starter_hash: starterHash, file_count: fileCount, bytes, created_at: createdAt, hidden: 0,
      });
      return { rows: [], first: null };
    }
    if (text.startsWith('INSERT INTO publish_events')) {
      publishEvents.push({ author_id: args[0], created_at: args[1] });
      return { rows: [], first: null };
    }
    if (text.startsWith('UPDATE versions SET name')) {
      const row = versions.find((candidate) => candidate.id === args[2]);
      if (row) { row.name = args[0]; row.description = args[1]; }
      return { rows: [], first: null };
    }
    if (text.startsWith('UPDATE versions SET hidden = 1')) {
      const row = versions.find((candidate) => candidate.id === args[0]);
      if (row) row.hidden = 1;
      return { rows: [], first: null };
    }
    throw new Error(`Unhandled statement: ${text}`);
  }

  const db = {
    prepare(sql: string) {
      let bound: (string | number)[] = [];
      const statement = {
        bind(...args: (string | number)[]) { bound = args; return statement; },
        async all() { return { results: run(sql, bound).rows }; },
        async first() { return run(sql, bound).first; },
        async run() { return run(sql, bound); },
      };
      return statement;
    },
  } as unknown as D1Database;

  return { db, versions, publishEvents };
}

function makeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, body: string) { objects.set(key, body); },
    async get(key: string) {
      const body = objects.get(key);
      return body === undefined ? null : { json: async () => JSON.parse(body) as unknown };
    },
    async delete(key: string) { objects.delete(key); },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

const overlay = { 'src/App.tsx': 'export default function App() { return null; }' };
const STARTER_HASH = '1111222233334444';

let bindings: VersionBindings;
let objects: Map<string, string>;
let author: string;
let other: string;

beforeEach(async () => {
  const database = makeDb();
  const storage = makeBucket();
  bindings = { db: database.db, bucket: storage.bucket };
  objects = storage.objects;
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
    expect(objects.has(`versions/${version.id}.json`)).toBe(true);

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
    expect(objects.size).toBe(0);
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
    // The blob is gone, and the id is not reusable.
    expect(objects.size).toBe(0);
    await expect(updateVersion(bindings, version.id, author, { name: 'Back' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('reports a missing blob rather than serving a half-broken version', async () => {
    const version = await publish();
    objects.clear();
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
    expect(requireBindings({ DB: bindings.db, VERSIONS: bindings.bucket })).toBeTruthy();
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
