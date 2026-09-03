import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuredProviders, epicClientId, isEpicConfigured } from '../lib/health/port';

/**
 * Epic issues *separate* non-production and production client ids for the same
 * app, so "is this configured" is a per-provider question. Getting this wrong is
 * silent: the connect button enables, the flow runs, and the provider rejects it
 * with an opaque error long after the mistake.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('client id selection', () => {
  it('uses the sandbox id for the sandbox provider', () => {
    vi.stubEnv('VITE_EPIC_CLIENT_ID', 'production-id');
    vi.stubEnv('VITE_EPIC_SANDBOX_CLIENT_ID', 'sandbox-id');

    expect(epicClientId('epic-sandbox')).toBe('sandbox-id');
    expect(epicClientId('ucsf')).toBe('production-id');
    expect(epicClientId('sutter')).toBe('production-id');
    expect(epicClientId()).toBe('production-id');
  });

  it('falls back to the main id when no sandbox id is set', () => {
    vi.stubEnv('VITE_EPIC_CLIENT_ID', 'production-id');
    vi.stubEnv('VITE_EPIC_SANDBOX_CLIENT_ID', '');
    expect(epicClientId('epic-sandbox')).toBe('production-id');
  });

  it('counts as configured when only the sandbox id is set', () => {
    // The bug this pins: reading only VITE_EPIC_CLIENT_ID left the whole panel
    // disabled for someone who had correctly configured just the sandbox.
    vi.stubEnv('VITE_EPIC_CLIENT_ID', '');
    vi.stubEnv('VITE_EPIC_SANDBOX_CLIENT_ID', 'sandbox-id');

    expect(isEpicConfigured()).toBe(true);
    expect(epicClientId('epic-sandbox')).toBe('sandbox-id');
    // ...but the production organizations are still not usable.
    expect(epicClientId('ucsf')).toBeNull();
    expect(configuredProviders()).toEqual(['epic-sandbox']);
  });

  it('reports nothing configured when neither is set', () => {
    vi.stubEnv('VITE_EPIC_CLIENT_ID', '');
    vi.stubEnv('VITE_EPIC_SANDBOX_CLIENT_ID', '');
    expect(isEpicConfigured()).toBe(false);
    expect(configuredProviders()).toEqual([]);
  });

  it('lists every provider when a production id is set', () => {
    vi.stubEnv('VITE_EPIC_CLIENT_ID', 'production-id');
    vi.stubEnv('VITE_EPIC_SANDBOX_CLIENT_ID', '');
    expect(configuredProviders()).toEqual(['ucsf', 'sutter', 'epic-sandbox']);
  });
});
