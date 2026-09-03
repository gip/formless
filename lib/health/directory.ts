'use client';

/**
 * Epic's published organization directory, as a lazily-fetched snapshot.
 *
 * Loaded the way `demo-record.ts` loads its fixture — a module-level promise
 * cache, one `fetch`, failure collapsing to `undefined` — for the same reason:
 * a missing asset must be a **soft failure**. With no snapshot the connect panel
 * falls back to the curated organizations in `providers.ts` and everything else
 * still works, which is the rule `AGENTS.md` states for `NEXT_PUBLIC_EPIC_CLIENT_ID`
 * and the versions API alike. Never make the canvas depend on it.
 *
 * The file is committed, not fetched from open.epic.com at runtime. Refresh it
 * with `pnpm generate:directory`.
 */

export const DIRECTORY_URL = '/directory/epic-r4.json';

/** One organization. `myChartName` is absent from Epic's data; the registry defaults it. */
export interface DirectoryEntry {
  id: string;
  name: string;
  fhirBase: string;
}

function isDirectoryEntry(value: unknown): value is DirectoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.fhirBase === 'string' &&
    entry.fhirBase.startsWith('https://')
  );
}

let cached: Promise<DirectoryEntry[]> | null = null;

async function load(): Promise<DirectoryEntry[]> {
  try {
    const response = await fetch(DIRECTORY_URL);
    if (!response.ok) return [];
    const value: unknown = await response.json();
    return Array.isArray(value) ? value.filter(isDirectoryEntry) : [];
  } catch {
    return [];
  }
}

/** Every organization in the snapshot, or an empty list if it could not be read. */
export function listDirectory(): Promise<DirectoryEntry[]> {
  cached ??= load();
  return cached;
}

export async function findDirectoryEntry(id: string): Promise<DirectoryEntry | undefined> {
  return (await listDirectory()).find((entry) => entry.id === id);
}
