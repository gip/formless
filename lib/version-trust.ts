import type { AppVersion } from './canvas-types';

/**
 * Versions the person at this browser has chosen to run with full access.
 *
 * `computeGrant()` refuses `auth.*` and `record.*` to any version this browser
 * did not publish, which is the right default: a published version is a
 * stranger's code and nobody has reviewed it. But the refusal used to be the end
 * of the conversation — the connect button simply went dead. This is the escape
 * hatch, taken deliberately through `VersionTrustPrompt` and never implicitly.
 *
 * Trust is recorded as id -> `contentHash`, not as a bare id. `updateVersion()`
 * only ever rewrites a version's name and description, so today a given id
 * always names the same overlay — but pinning the hash means that if that ever
 * stops being true, trust granted for the code someone read does not silently
 * carry over to code they did not.
 *
 * It is per browser profile and deliberately not synced anywhere: this is a
 * statement about what this person, at this machine, decided to run.
 *
 * Exposed as an external store rather than as component state because the host
 * page is server-rendered: `getServerTrustedVersions()` answers "nothing is
 * trusted" for the prerender, and the real record arrives at hydration without a
 * mismatch and without an effect that sets state on mount.
 */

const STORAGE_KEY = 'formless.trusted-versions/v1';

/** Version id -> the `contentHash` that was trusted. */
export type TrustedVersions = Readonly<Record<string, string>>;

export const NO_TRUSTED_VERSIONS: TrustedVersions = {};

/**
 * Cached so `getTrustedVersions()` is referentially stable between writes.
 * `useSyncExternalStore` calls it on every render and re-renders forever if the
 * identity changes without a notification.
 */
let snapshot: TrustedVersions | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): TrustedVersions {
  if (!raw) return NO_TRUSTED_VERSIONS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_TRUSTED_VERSIONS;
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
    return Object.fromEntries(entries);
  } catch {
    return NO_TRUSTED_VERSIONS;
  }
}

export function subscribeTrustedVersions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The record as this browser holds it.
 *
 * Every failure answers "nothing is trusted", which is the safe direction: a
 * browser that refuses `localStorage` (private mode, partitioned storage,
 * storage switched off) re-asks rather than granting access it cannot prove was
 * granted.
 */
export function getTrustedVersions(): TrustedVersions {
  if (snapshot === null) {
    try {
      snapshot = parse(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      snapshot = NO_TRUSTED_VERSIONS;
    }
  }
  return snapshot;
}

/** Nothing is trusted during the prerender: there is no browser to have decided. */
export function getServerTrustedVersions(): TrustedVersions {
  return NO_TRUSTED_VERSIONS;
}

/**
 * Records trust for one version.
 *
 * The in-memory snapshot moves even when the write throws, so a browser that
 * refuses storage still honours the choice for this session and re-asks on the
 * next load.
 */
export function trustVersion(version: AppVersion): void {
  const next = { ...getTrustedVersions(), [version.id]: version.contentHash };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Session-only trust. Better than dropping the choice just made.
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

/** True when this exact overlay was trusted, by content and not merely by id. */
export function isVersionTrusted(version: AppVersion, trusted: TrustedVersions): boolean {
  return trusted[version.id] === version.contentHash;
}

/** Test seam: drops the cached snapshot so the next read hits storage again. */
export function resetTrustedVersionsCache(): void {
  snapshot = null;
  listeners.clear();
}
