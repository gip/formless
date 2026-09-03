import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppVersion } from '../lib/canvas-types';
import {
  getServerTrustedVersions,
  getTrustedVersions,
  isVersionTrusted,
  NO_TRUSTED_VERSIONS,
  resetTrustedVersionsCache,
  subscribeTrustedVersions,
  trustVersion,
} from '../lib/version-trust';

const STORAGE_KEY = 'formless.trusted-versions/v1';

function version(overrides: Partial<AppVersion> & { id: string }): AppVersion {
  return {
    name: 'A version',
    description: '',
    contentHash: 'hash-1',
    authorLabel: 'builder-abc123',
    mine: false,
    starterHash: 'starter-1',
    fileCount: 1,
    bytes: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The node environment has no `window`; the store only ever touches these two. */
function installStorage(store: Map<string, string>, options: { throws?: boolean } = {}) {
  const localStorage = {
    getItem: (key: string) => {
      if (options.throws) throw new Error('storage is disabled');
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.throws) throw new Error('storage is disabled');
      store.set(key, value);
    },
  };
  vi.stubGlobal('window', { localStorage });
}

describe('trusted versions store', () => {
  beforeEach(() => { resetTrustedVersionsCache(); });
  afterEach(() => { vi.unstubAllGlobals(); resetTrustedVersionsCache(); });

  it('trusts nothing during the prerender', () => {
    expect(getServerTrustedVersions()).toEqual(NO_TRUSTED_VERSIONS);
  });

  it('reads what a previous session wrote', () => {
    installStorage(new Map([[STORAGE_KEY, JSON.stringify({ v1: 'hash-1' })]]));
    expect(getTrustedVersions()).toEqual({ v1: 'hash-1' });
  });

  it('records trust by content hash and notifies subscribers', () => {
    const store = new Map<string, string>();
    installStorage(store);
    const listener = vi.fn();
    subscribeTrustedVersions(listener);

    trustVersion(version({ id: 'v1', contentHash: 'hash-1' }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getTrustedVersions()).toEqual({ v1: 'hash-1' });
    expect(JSON.parse(store.get(STORAGE_KEY) ?? '{}')).toEqual({ v1: 'hash-1' });
  });

  it('matches only the exact overlay that was trusted', () => {
    const trusted = { v1: 'hash-1' };
    expect(isVersionTrusted(version({ id: 'v1', contentHash: 'hash-1' }), trusted)).toBe(true);
    expect(isVersionTrusted(version({ id: 'v1', contentHash: 'hash-2' }), trusted)).toBe(false);
    expect(isVersionTrusted(version({ id: 'v2', contentHash: 'hash-1' }), trusted)).toBe(false);
  });

  it('trusts nothing when storage cannot be read', () => {
    // Private mode and partitioned storage both throw here. Failing closed means
    // the warning is shown again, not that access is granted unprovably.
    installStorage(new Map(), { throws: true });
    expect(getTrustedVersions()).toEqual(NO_TRUSTED_VERSIONS);
  });

  it('keeps the choice for this session when the write throws', () => {
    installStorage(new Map(), { throws: true });
    trustVersion(version({ id: 'v1', contentHash: 'hash-1' }));
    expect(getTrustedVersions()).toEqual({ v1: 'hash-1' });
  });

  it('ignores a stored record that is not id -> hash', () => {
    installStorage(new Map([[STORAGE_KEY, JSON.stringify({ v1: { forged: true }, v2: 'hash-2' })]]));
    expect(getTrustedVersions()).toEqual({ v2: 'hash-2' });
  });

  it('ignores a stored record that is not an object', () => {
    installStorage(new Map([[STORAGE_KEY, '["v1"]']]));
    expect(getTrustedVersions()).toEqual(NO_TRUSTED_VERSIONS);
  });
});
