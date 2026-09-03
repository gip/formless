import type { AppVersion, CapabilityGrant, HostResponseMessage } from './canvas-types';
import { isVersionTrusted, NO_TRUSTED_VERSIONS, type TrustedVersions } from './version-trust';

/**
 * The host half of the guest capability protocol.
 *
 * The guest is untrusted by construction — `src/App.tsx` and everything under
 * `src/components/` is exactly what an agent (or a stranger who published a
 * version) is allowed to rewrite. So the guest never holds an access token or an
 * encryption key: it asks the host for a decrypted record and gets one, or is
 * refused. Every method here is a deliberate hole in that wall, and each one is
 * gated by `CapabilityGrant`.
 *
 * Kept free of DOM and of `lib/health/**` imports so it can be exercised under
 * the node test environment against stub ports, the same way `version-store.ts`
 * takes injected bindings.
 */

export const STARTER_SCOPE = 'starter';

/** Guest state caps. A published version should not be able to fill the origin's quota. */
export const MAX_STATE_KEY_LENGTH = 128;
export const MAX_STATE_VALUE_BYTES = 64 * 1024;
export const MAX_STATE_KEYS_PER_SCOPE = 100;

export interface AuthStatus {
  /** True when at least one provider has a client id. */
  configured: boolean;
  /**
   * Which credentials exist. Epic issues separate non-production and production
   * client ids, so "configured" is per *environment*, not global — without this
   * the UI offers to connect to an organization it has no credential for, and the
   * failure only surfaces at the provider.
   *
   * This used to be a list of provider ids. That could only ever answer for the
   * hand-written registry, so every organization resolved from Epic's published
   * directory failed the membership test and rendered with a permanently disabled
   * connect button. The question was always about credentials, not identity.
   */
  credentials: { production: boolean; sandbox: boolean };
  connected: boolean;
  provider: string | null;
  /** `empty` | `locked` | `unlocked` — mirrors the record's storage state. */
  record: 'empty' | 'locked' | 'unlocked';
}

/**
 * What the host knows about the record right now, including *which* record.
 *
 * `getRecord()` cannot answer that: it falls back to the de-identified sample
 * whenever the store is empty, and returns nothing at all while an import is
 * running or the store is locked — three very different situations that look
 * identical to a caller. The guest does not need to tell them apart, because
 * it renders connection state from `AuthStatus` anyway. A tool does: an agent
 * narrating the sample as the user's own history is the worst thing this
 * feature can do.
 *
 * `record` is typed `unknown` for the same reason `getRecord()` is — this
 * module stays free of `lib/health/**` imports so it can be exercised against
 * stub ports under the node test environment.
 */
export interface HealthSnapshot {
  status: AuthStatus;
  source: 'connected' | 'sample' | 'none';
  /** Why there is no record. Only set when `source` is `none`. */
  reason?: 'locked' | 'importing' | 'unavailable';
  record?: unknown;
}

/** Everything the health subsystem exposes to the guest. Implemented in `lib/health/`. */
export interface HealthPort {
  status(): Promise<AuthStatus>;
  /**
   * Host-only. Deliberately absent from `dispatchCapability`: the bridge
   * surface the guest can reach is unchanged by this method's existence.
   */
  snapshot(): Promise<HealthSnapshot>;
  /**
   * Every organization the user can pick, curated first then Epic's directory.
   *
   * Typed `unknown` for the same reason `getRecord()` is: this module stays free
   * of `lib/health/**` imports so it can be exercised against stub ports.
   */
  providers(): Promise<unknown>;
  connect(params: { providerId: string; includeAttachments: boolean }): Promise<AuthStatus>;
  disconnect(): Promise<AuthStatus>;
  getRecord(): Promise<unknown>;
  unlock(): Promise<AuthStatus>;
  lock(): Promise<AuthStatus>;
  clear(): Promise<AuthStatus>;
  download(): Promise<void>;
}

/** Host-owned, version-namespaced key/value storage for the guest. */
export interface StatePort {
  get(scope: string, key: string): Promise<unknown>;
  set(scope: string, key: string, value: unknown): Promise<void>;
  delete(scope: string, key: string): Promise<void>;
  keyCount(scope: string): Promise<number>;
}

export interface CapabilityDeps {
  health: HealthPort;
  state: StatePort;
  grant: () => CapabilityGrant;
}

export class CapabilityError extends Error {}

/**
 * The starter is yours. A version you published is yours. Anything else is a
 * stranger's code, and gets state (namespaced) but never auth or health data —
 * unless the person at this browser was shown `VersionTrustPrompt` and chose to
 * run it anyway, which is what `trusted` carries.
 *
 * Trust is only ever consulted for a version the host has actually listed. An id
 * that is not in `versions` stays unprivileged however it is spelled: the host
 * has no `contentHash` to check the trust record against, so there is nothing it
 * could be matching against except the id an attacker chose.
 */
export function computeGrant(
  versionId: string | null,
  versions: readonly AppVersion[],
  trusted: TrustedVersions = NO_TRUSTED_VERSIONS,
): CapabilityGrant {
  if (!versionId) return { scope: STARTER_SCOPE, privileged: true };
  const version = versions.find((entry) => entry.id === versionId);
  if (!version) return { scope: versionId, privileged: false };
  return { scope: versionId, privileged: version.mine || isVersionTrusted(version, trusted) };
}

const PRIVILEGED_PREFIXES = ['auth.', 'record.'];

export function requiresPrivilege(method: string): boolean {
  return PRIVILEGED_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function requireKey(params: Record<string, unknown> | undefined): string {
  const key = params?.key;
  if (typeof key !== 'string' || !key) throw new CapabilityError('A state key is required.');
  if (key.length > MAX_STATE_KEY_LENGTH) {
    throw new CapabilityError(`A state key may be at most ${MAX_STATE_KEY_LENGTH} characters.`);
  }
  return key;
}

function measure(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    throw new CapabilityError('A state value must be JSON-serializable.');
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function providerId(params: Record<string, unknown> | undefined): string {
  const value = params?.providerId;
  if (typeof value !== 'string' || !value) throw new CapabilityError('A providerId is required.');
  return value;
}

/**
 * Resolves one `host-request` into the value that goes back as `host-response`.
 * Throws `CapabilityError` for anything the guest is not allowed to do; the
 * caller turns that into `{ ok: false, error }` rather than letting it escape.
 */
export async function dispatchCapability(
  deps: CapabilityDeps,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const grant = deps.grant();

  if (requiresPrivilege(method) && !grant.privileged) {
    throw new CapabilityError(
      'This version was published by someone else, so it cannot reach your health record or '
    + 'connection. Choose "Sandboxed" in the header to review it and allow access.',
    );
  }

  switch (method) {
    case 'state.get':
      return deps.state.get(grant.scope, requireKey(params));

    case 'state.set': {
      const key = requireKey(params);
      const bytes = measure(params?.value);
      if (bytes > MAX_STATE_VALUE_BYTES) {
        throw new CapabilityError(`A state value may be at most ${MAX_STATE_VALUE_BYTES} bytes.`);
      }
      // Only a new key can push the scope over its limit; overwriting is always fine.
      if ((await deps.state.get(grant.scope, key)) === undefined) {
        if ((await deps.state.keyCount(grant.scope)) >= MAX_STATE_KEYS_PER_SCOPE) {
          throw new CapabilityError(`A version may store at most ${MAX_STATE_KEYS_PER_SCOPE} keys.`);
        }
      }
      await deps.state.set(grant.scope, key, params?.value ?? null);
      return { ok: true };
    }

    case 'state.delete':
      await deps.state.delete(grant.scope, requireKey(params));
      return { ok: true };

    case 'auth.status':
      return deps.health.status();

    case 'auth.providers':
      return deps.health.providers();

    case 'auth.connect':
      return deps.health.connect({
        providerId: providerId(params),
        includeAttachments: params?.includeAttachments === true,
      });

    case 'auth.disconnect':
      return deps.health.disconnect();

    case 'record.get':
      return deps.health.getRecord();

    case 'record.unlock':
      return deps.health.unlock();

    case 'record.lock':
      return deps.health.lock();

    case 'record.clear':
      return deps.health.clear();

    case 'record.download':
      await deps.health.download();
      return { ok: true };

    default:
      throw new CapabilityError(`Unknown capability method: ${method}`);
  }
}

/** Wraps `dispatchCapability` into the exact envelope the guest expects back. */
export async function respondToCapability(
  deps: CapabilityDeps,
  id: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<HostResponseMessage> {
  try {
    return { id, ok: true, value: await dispatchCapability(deps, method, params) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The request failed.';
    return { id, ok: false, error: message };
  }
}
