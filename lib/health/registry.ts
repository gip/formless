'use client';

import { findDirectoryEntry, listDirectory } from './directory';
import { PROVIDERS, getProvider, type ProviderProfile } from './providers';

/**
 * Provider lookup across both tiers: the hand-written registry, then Epic's
 * published directory.
 *
 * This exists rather than growing `providers.ts` because that file is a verbatim
 * port from the sibling `yesyouhealth` app (`AGENTS.md`) and stays untouched. It
 * remains the source of truth for the organizations we describe by hand — real
 * portal names, per-provider scope or capability overrides — and this module
 * layers the other ~477 on top.
 *
 * Curated wins on id collision, so adding an entry to `PROVIDERS` is always the
 * way to correct or enrich a directory organization.
 */

/**
 * What a directory organization gets when nothing hand-written describes it.
 *
 * `myChartName` is the interesting one: Epic's endpoint list carries no portal
 * branding at all, and "MyChart" is Epic's own name for the patient portal, which
 * is what the large majority of these organizations actually call it. Where we
 * know better — "Sutter My Health Online" — the curated entry says so.
 */
const DIRECTORY_DEFAULTS = {
  myChartName: 'MyChart',
  vendor: 'epic',
  adapter: 'epic-r4',
  environment: 'production',
  capabilities: { attachments: true, priorAuthorizations: true },
  enabled: true,
} as const satisfies Partial<ProviderProfile>;

function fromDirectory(entry: { id: string; name: string; fhirBase: string }): ProviderProfile {
  return { ...DIRECTORY_DEFAULTS, id: entry.id, name: entry.name, fhirBase: entry.fhirBase };
}

/**
 * The profile for an id, or `undefined`.
 *
 * Async because the directory is a fetched snapshot. Both callers —
 * `session.ts:authorize()` and `import.ts:connectAndImport()` — are already async,
 * and nothing in the app needs a synchronous provider lookup: `port.ts` decides
 * whether a connection is possible from `epicClientId()` alone.
 */
export async function resolveProvider(id: string | null | undefined): Promise<ProviderProfile | undefined> {
  const curated = getProvider(id);
  if (curated) return curated;
  if (!id) return undefined;
  const entry = await findDirectoryEntry(id);
  return entry ? fromDirectory(entry) : undefined;
}

/** What the connect panel needs to render and filter a picker. */
export interface ProviderChoice {
  id: string;
  name: string;
  myChartName: string;
  sandbox: boolean;
}

function toChoice(provider: ProviderProfile): ProviderChoice {
  return {
    id: provider.id,
    name: provider.name,
    myChartName: provider.myChartName,
    sandbox: provider.environment === 'sandbox',
  };
}

/**
 * Every selectable organization, curated first, then the directory by name.
 *
 * Sent to the guest whole — ~42 KB for the current directory — rather than
 * searched per keystroke. One structured-clone buys instant local filtering and
 * sidesteps a race the bridge cannot help with: `hostRequest` has no sequencing,
 * so a search-per-keystroke design can paint a slow early response over a fast
 * later one.
 */
export async function listProviderChoices(): Promise<ProviderChoice[]> {
  const curated = Object.values(PROVIDERS) as ProviderProfile[];
  const curatedIds = new Set(curated.map((provider) => provider.id));
  const directory = (await listDirectory())
    .filter((entry) => !curatedIds.has(entry.id))
    .map((entry) => toChoice(fromDirectory(entry)));
  return [...curated.map(toChoice), ...directory];
}
