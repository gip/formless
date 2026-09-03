import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppVersion, CapabilityGrant } from '../lib/canvas-types';
import {
  computeGrant,
  dispatchCapability,
  MAX_STATE_KEYS_PER_SCOPE,
  MAX_STATE_VALUE_BYTES,
  requiresPrivilege,
  respondToCapability,
  STARTER_SCOPE,
  type CapabilityDeps,
  type HealthPort,
  type StatePort,
} from '../lib/host-capabilities';

function version(overrides: Partial<AppVersion> & { id: string }): AppVersion {
  return {
    name: 'A version',
    description: '',
    contentHash: 'abc',
    authorLabel: 'builder-000000',
    mine: false,
    starterHash: '0000000000000000',
    fileCount: 1,
    bytes: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function memoryState(): StatePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const id = (scope: string, key: string) => `${scope}\u0000${key}`;
  return {
    store,
    async get(scope, key) { return store.get(id(scope, key)); },
    async set(scope, key, value) { store.set(id(scope, key), value); },
    async delete(scope, key) { store.delete(id(scope, key)); },
    async keyCount(scope) {
      return [...store.keys()].filter((entry) => entry.startsWith(`${scope}\u0000`)).length;
    },
  };
}

function stubHealth(): HealthPort {
  const status = {
    configured: true,
    configuredProviders: ['ucsf', 'epic-sandbox'],
    connected: true,
    provider: 'ucsf',
    record: 'unlocked' as const,
  };
  return {
    status: vi.fn(async () => status),
    connect: vi.fn(async () => status),
    disconnect: vi.fn(async () => status),
    getRecord: vi.fn(async () => ({ schemaVersion: 1 })),
    unlock: vi.fn(async () => status),
    lock: vi.fn(async () => status),
    clear: vi.fn(async () => status),
    download: vi.fn(async () => undefined),
  };
}

let deps: CapabilityDeps;
let state: ReturnType<typeof memoryState>;
let health: HealthPort;
let grant: CapabilityGrant;

beforeEach(() => {
  state = memoryState();
  health = stubHealth();
  grant = { scope: STARTER_SCOPE, privileged: true };
  deps = { health, state, grant: () => grant };
});

describe('computeGrant', () => {
  it('trusts the starter', () => {
    expect(computeGrant(null, [])).toEqual({ scope: STARTER_SCOPE, privileged: true });
  });

  it('trusts a version this browser published', () => {
    const versions = [version({ id: 'v1', mine: true })];
    expect(computeGrant('v1', versions)).toEqual({ scope: 'v1', privileged: true });
  });

  it('does not trust a version published by someone else', () => {
    const versions = [version({ id: 'v1', mine: false })];
    expect(computeGrant('v1', versions)).toEqual({ scope: 'v1', privileged: false });
  });

  it('does not trust a version it has never heard of', () => {
    // A version id from a `?version=` deep link that failed to list must not
    // default open just because the host has no record of who published it.
    expect(computeGrant('unknown', [])).toEqual({ scope: 'unknown', privileged: false });
  });
});

describe('privilege gating', () => {
  it('classifies auth and record as privileged, state as not', () => {
    expect(requiresPrivilege('auth.connect')).toBe(true);
    expect(requiresPrivilege('record.get')).toBe(true);
    expect(requiresPrivilege('state.get')).toBe(false);
  });

  it("refuses health data to a stranger's published version", async () => {
    grant = { scope: 'v1', privileged: false };
    for (const method of ['record.get', 'auth.status', 'auth.connect', 'record.clear']) {
      await expect(dispatchCapability(deps, method)).rejects.toThrow(/published by someone else/);
    }
    expect(health.getRecord).not.toHaveBeenCalled();
    expect(health.clear).not.toHaveBeenCalled();
  });

  it('still allows an untrusted version its own scoped state', async () => {
    grant = { scope: 'v1', privileged: false };
    await dispatchCapability(deps, 'state.set', { key: 'view', value: 'raw' });
    expect(await dispatchCapability(deps, 'state.get', { key: 'view' })).toBe('raw');
  });
});

describe('state namespacing', () => {
  it('cannot read another version state', async () => {
    grant = { scope: 'v1', privileged: false };
    await dispatchCapability(deps, 'state.set', { key: 'secret', value: 'from-v1' });

    grant = { scope: 'v2', privileged: false };
    expect(await dispatchCapability(deps, 'state.get', { key: 'secret' })).toBeUndefined();

    grant = { scope: STARTER_SCOPE, privileged: true };
    expect(await dispatchCapability(deps, 'state.get', { key: 'secret' })).toBeUndefined();
  });

  it('deletes only within its own scope', async () => {
    grant = { scope: 'v1', privileged: false };
    await dispatchCapability(deps, 'state.set', { key: 'k', value: 1 });
    grant = { scope: 'v2', privileged: false };
    await dispatchCapability(deps, 'state.delete', { key: 'k' });

    grant = { scope: 'v1', privileged: false };
    expect(await dispatchCapability(deps, 'state.get', { key: 'k' })).toBe(1);
  });
});

describe('state limits', () => {
  it('rejects an oversized value', async () => {
    const value = 'x'.repeat(MAX_STATE_VALUE_BYTES + 1);
    await expect(dispatchCapability(deps, 'state.set', { key: 'k', value })).rejects.toThrow(/at most/);
  });

  it('rejects a missing or overlong key', async () => {
    await expect(dispatchCapability(deps, 'state.get', {})).rejects.toThrow(/state key is required/);
    await expect(
      dispatchCapability(deps, 'state.set', { key: 'k'.repeat(200), value: 1 }),
    ).rejects.toThrow(/at most/);
  });

  it('caps the number of keys but still allows overwriting an existing one', async () => {
    for (let index = 0; index < MAX_STATE_KEYS_PER_SCOPE; index += 1) {
      await dispatchCapability(deps, 'state.set', { key: `k${index}`, value: index });
    }
    await expect(dispatchCapability(deps, 'state.set', { key: 'overflow', value: 1 })).rejects.toThrow(
      /at most/,
    );
    await expect(dispatchCapability(deps, 'state.set', { key: 'k0', value: 'replaced' })).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects a value that cannot be serialized', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(dispatchCapability(deps, 'state.set', { key: 'k', value: circular })).rejects.toThrow(
      /JSON-serializable/,
    );
  });
});

describe('health passthrough', () => {
  it('requires a providerId to connect', async () => {
    await expect(dispatchCapability(deps, 'auth.connect', {})).rejects.toThrow(/providerId is required/);
  });

  it('forwards connect options', async () => {
    await dispatchCapability(deps, 'auth.connect', { providerId: 'ucsf', includeAttachments: true });
    expect(health.connect).toHaveBeenCalledWith({ providerId: 'ucsf', includeAttachments: true });
  });

  it('defaults includeAttachments to false rather than passing it through loosely', async () => {
    await dispatchCapability(deps, 'auth.connect', { providerId: 'ucsf', includeAttachments: 'yes' });
    expect(health.connect).toHaveBeenCalledWith({ providerId: 'ucsf', includeAttachments: false });
  });
});

describe('respondToCapability', () => {
  it('wraps a success', async () => {
    await expect(respondToCapability(deps, 'r1', 'record.get')).resolves.toEqual({
      id: 'r1',
      ok: true,
      value: { schemaVersion: 1 },
    });
  });

  it('turns a refusal into a response rather than throwing', async () => {
    grant = { scope: 'v1', privileged: false };
    const response = await respondToCapability(deps, 'r2', 'record.get');
    expect(response.ok).toBe(false);
    expect(response.id).toBe('r2');
    expect(response.error).toMatch(/published by someone else/);
  });

  it('rejects an unknown method', async () => {
    const response = await respondToCapability(deps, 'r3', 'record.exfiltrate');
    expect(response).toMatchObject({ ok: false, error: expect.stringContaining('Unknown capability') });
  });
});
