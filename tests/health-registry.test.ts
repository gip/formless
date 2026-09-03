import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Provider resolution across both tiers.
 *
 * The interesting cases are the failures. `lib/health/directory.ts` fetches a
 * static asset, and `AGENTS.md` is explicit that missing health configuration is
 * a **soft failure** — so a directory that will not load has to leave the curated
 * organizations working rather than take the panel down with it.
 *
 * `vi.resetModules()` between tests because the loader caches its promise at
 * module scope, which is the whole point of it in the browser.
 */

const ENTRIES = [
  { id: 'cleveland-clinic', name: 'Cleveland Clinic', fhirBase: 'https://api.ccf.org/fhir/api/FHIR/R4/' },
  { id: 'atrius-health', name: 'Atrius Health', fhirBase: 'https://iatrius.atriushealth.org/FHIR/api/FHIR/R4/' },
];

function stubDirectory(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    json: async () => body,
  })));
}

async function registry() {
  return import('../lib/health/registry');
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('resolveProvider', () => {
  it('resolves an organization from the directory', async () => {
    stubDirectory(ENTRIES);
    const provider = await (await registry()).resolveProvider('cleveland-clinic');
    expect(provider).toMatchObject({
      id: 'cleveland-clinic',
      name: 'Cleveland Clinic',
      adapter: 'epic-r4',
      environment: 'production',
    });
    // Epic's endpoint list carries no portal branding, so directory entries take
    // Epic's own name for the patient portal.
    expect(provider?.myChartName).toBe('MyChart');
  });

  it('prefers the curated profile over a directory entry', async () => {
    stubDirectory([{ id: 'ucsf', name: 'Not UCSF', fhirBase: 'https://example.org/api/FHIR/R4/' }]);
    const provider = await (await registry()).resolveProvider('ucsf');
    // The hand-written registry is how a directory organization gets corrected
    // or enriched, so it has to win outright.
    expect(provider?.name).toBe('UCSF Health');
    expect(provider?.myChartName).toBe('UCSF MyChart');
    expect(provider?.fhirBase).toContain('ucsf.edu');
  });

  it('keeps the curated organizations working when the directory will not load', async () => {
    stubDirectory(undefined, false);
    const { resolveProvider } = await registry();
    expect(await resolveProvider('ucsf')).toMatchObject({ name: 'UCSF Health' });
    expect(await resolveProvider('cleveland-clinic')).toBeUndefined();
  });

  it('survives a directory that is not an array', async () => {
    stubDirectory({ nope: true });
    expect(await (await registry()).resolveProvider('ucsf')).toMatchObject({ name: 'UCSF Health' });
  });

  it('returns nothing for an unknown id', async () => {
    stubDirectory(ENTRIES);
    expect(await (await registry()).resolveProvider('not-a-provider')).toBeUndefined();
    expect(await (await registry()).resolveProvider(null)).toBeUndefined();
  });
});

describe('listProviderChoices', () => {
  it('lists the curated organizations first, then the directory', async () => {
    stubDirectory(ENTRIES);
    const choices = await (await registry()).listProviderChoices();
    expect(choices.slice(0, 3).map((choice) => choice.id)).toEqual(['ucsf', 'sutter', 'epic-sandbox']);
    expect(choices.map((choice) => choice.id)).toContain('cleveland-clinic');
  });

  it('marks only the sandbox as a sandbox', async () => {
    stubDirectory(ENTRIES);
    const choices = await (await registry()).listProviderChoices();
    expect(choices.filter((choice) => choice.sandbox).map((choice) => choice.id)).toEqual(['epic-sandbox']);
  });

  it('never lists a directory entry that shadows a curated id', async () => {
    stubDirectory([{ id: 'ucsf', name: 'Impostor', fhirBase: 'https://example.org/api/FHIR/R4/' }]);
    const choices = await (await registry()).listProviderChoices();
    expect(choices.filter((choice) => choice.id === 'ucsf')).toHaveLength(1);
    expect(choices.find((choice) => choice.id === 'ucsf')?.name).toBe('UCSF Health');
  });

  it('still offers the curated organizations with no directory at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const choices = await (await registry()).listProviderChoices();
    expect(choices.map((choice) => choice.id)).toEqual(['ucsf', 'sutter', 'epic-sandbox']);
  });

  it('rejects malformed rows rather than trusting the asset', async () => {
    stubDirectory([
      { id: 'good', name: 'Good Health', fhirBase: 'https://good.example.org/api/FHIR/R4/' },
      { id: 'insecure', name: 'Insecure', fhirBase: 'http://insecure.example.org/api/FHIR/R4/' },
      { id: 'nameless', fhirBase: 'https://nameless.example.org/api/FHIR/R4/' },
    ]);
    const ids = (await (await registry()).listProviderChoices()).map((choice) => choice.id);
    expect(ids).toContain('good');
    expect(ids).not.toContain('insecure');
    expect(ids).not.toContain('nameless');
  });
});
