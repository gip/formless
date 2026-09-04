import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRecord } from '../lib/health/storage';
import type { HealthExportDocument } from '../lib/health/types';

/**
 * Which record the port hands out, and when.
 *
 * The de-identified fixture used to be the answer to `getRecord()` whenever the
 * store was empty, which made a stranger's chart the default content of
 * `/explore`. Anything that reloaded the guest on that route — a version switch
 * most often, since it rewrites `src/**` and Vite full-reloads onto the hash
 * still in the iframe's URL — put John Smith's history under the same headings
 * a real import uses. These pin the rule that replaced it: the sample appears
 * only because someone asked for it, and every other state says plainly that
 * there is nothing to show.
 *
 * `createHealthPort` is imported per test with `resetModules`, because both it
 * and `demo-record.ts` hold module-level caches that would otherwise leak the
 * previous test's answer into the next one.
 */

const PASSPHRASE = 'correct horse battery staple';

function fixture(name: string): HealthExportDocument {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    exportedBy: 'Formless Health',
    source: { provider: name, fhirBase: 'https://example.invalid/fhir', patientId: 'p1' },
    purpose: 'personal',
    data: {},
    errors: {},
    priorAuthorizations: [],
    limitations: [],
    attachments: [],
  } as unknown as HealthExportDocument;
}

const DEMO = fixture('Demo Health');

/**
 * A port with the hooks stubbed; nothing here reaches OAuth or host chrome.
 *
 * `storage` comes back from the same freshly-registered module graph the port
 * itself imported. The derived key is module state in `storage.ts`, so a test
 * that saved a record through the file's own top-level import would be talking
 * to a different copy — one whose key the port cannot see, leaving every stored
 * record looking locked.
 */
async function makePort() {
  vi.resetModules();
  const emit = vi.fn();
  const [{ createHealthPort }, storage] = await Promise.all([
    import('../lib/health/port'),
    import('../lib/health/storage'),
  ]);
  return {
    emit,
    storage,
    port: createHealthPort({
      requestPassphrase: async () => PASSPHRASE,
      runConnect: async () => fixture('UCSF Health'),
      emit,
    }),
  };
}

beforeEach(() => {
  // The fixture is fetched from the host's `public/`, so the port's only outside
  // dependency is this one request.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DEMO), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // The store is the one piece of real shared state here: `fake-indexeddb` is a
  // single global database, while the in-memory key dies with the module graph.
  await clearRecord();
});

describe('an empty store', () => {
  it('offers nothing at all until the sample is asked for', async () => {
    const { port } = await makePort();

    const snapshot = await port.snapshot();
    expect(snapshot).toMatchObject({ source: 'none', reason: 'empty' });
    expect(snapshot.record).toBeUndefined();
    expect(snapshot.status.sample).toBe(false);
    expect(await port.getRecord()).toBeUndefined();
    // The point of the whole change: nothing fetched the fixture.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves the sample once asked, and says so in the status', async () => {
    const { port, emit } = await makePort();

    const status = await port.showSample(true);
    expect(status.sample).toBe(true);
    // The guest re-reads the record on this event; without it the page would
    // keep rendering its empty state over a sample it has already been given.
    expect(emit).toHaveBeenCalledWith('record.changed');

    const snapshot = await port.snapshot();
    expect(snapshot.source).toBe('sample');
    expect(snapshot.record).toMatchObject({ source: { provider: 'Demo Health' } });
  });

  it('puts the sample away again on request', async () => {
    const { port } = await makePort();

    await port.showSample(true);
    expect((await port.showSample(false)).sample).toBe(false);
    expect(await port.snapshot()).toMatchObject({ source: 'none', reason: 'empty' });
  });

  it('reports the fixture as unavailable rather than pretending it is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const { port } = await makePort();

    await port.showSample(true);
    expect(await port.snapshot()).toMatchObject({ source: 'none', reason: 'unavailable' });
  });
});

describe('a stored record', () => {
  it('outranks a sample the user had asked for', async () => {
    const { port, storage } = await makePort();
    await port.showSample(true);

    await storage.saveRecord(fixture('UCSF Health'), PASSPHRASE, 'ucsf');

    const snapshot = await port.snapshot();
    expect(snapshot.source).toBe('connected');
    expect(snapshot.status.sample).toBe(false);
    expect(snapshot.record).toMatchObject({ source: { provider: 'UCSF Health' } });
  });

  it('refuses to arm the sample at all', async () => {
    const { port, storage } = await makePort();
    await storage.saveRecord(fixture('UCSF Health'), PASSPHRASE, 'ucsf');

    // Answering `true` here would leave the guest captioning a sample that is
    // not on screen, since the snapshot below is the real record either way.
    expect((await port.showSample(true)).sample).toBe(false);
    expect(await port.snapshot()).toMatchObject({ source: 'connected' });
  });

  it('yields nothing when locked, sample requested or not', async () => {
    const { port, storage } = await makePort();
    await storage.saveRecord(fixture('UCSF Health'), PASSPHRASE, 'ucsf');
    storage.lockRecord();

    await port.showSample(true);
    const snapshot = await port.snapshot();
    expect(snapshot).toMatchObject({ source: 'none', reason: 'locked' });
    expect(snapshot.record).toBeUndefined();
  });

  it('reports an unreadable store as unavailable, never as the sample', async () => {
    const { port, storage } = await makePort();
    await storage.saveRecord(fixture('UCSF Health'), PASSPHRASE, 'ucsf');

    // `saveRecord` leaves the key in memory, so the state stays `unlocked` while
    // the ciphertext underneath it no longer decrypts. That combination used to
    // fall through to the fixture — and because `connected` is true for any
    // non-empty store, the explorer captioned it "Your imported record".
    await corruptStoredCiphertext();

    const snapshot = await port.snapshot();
    expect(snapshot).toMatchObject({ source: 'none', reason: 'unavailable' });
    expect(snapshot.record).toBeUndefined();
    expect(snapshot.status.record).toBe('unlocked');
    expect(snapshot.status.sample).toBe(false);
  });

  it('disarms the sample when the record is removed', async () => {
    const { port } = await makePort();
    await port.showSample(true);
    expect((await port.snapshot()).source).toBe('sample');

    // Deleting your own data must not silently hand you someone else's.
    expect((await port.clear()).sample).toBe(false);
    expect(await port.snapshot()).toMatchObject({ source: 'none', reason: 'empty' });
  });
});

/** Flips a byte of the stored ciphertext, leaving the metadata intact. */
async function corruptStoredCiphertext(): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('webally-health', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const store = () => database.transaction('records', 'readwrite').objectStore('records');
    const stored = await new Promise<{ payload: { ciphertext: ArrayBuffer } }>((resolve, reject) => {
      const request = store().get('active');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    new Uint8Array(stored.payload.ciphertext)[0] ^= 0xff;
    await new Promise<void>((resolve, reject) => {
      const request = store().put(stored, 'active');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}
