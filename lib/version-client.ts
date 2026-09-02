'use client';

import type { AppVersion, AppVersionDetail, FileMap } from './canvas-types';

/**
 * Browser-side access to the published version gallery.
 *
 * Identity is an opaque publisher token minted on first publish and kept in
 * `localStorage`. It is never shown, never sent anywhere but this origin's own
 * API, and the server stores only a digest of it. There is no sign-in flow on
 * purpose: the macOS shell implements no `createWebViewWith`, so an OAuth popup
 * would be a dead end there.
 */

const TOKEN_KEY = 'webally-publisher-token';

export type VersionsResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Private windows and blocked site data both throw on access.
    return null;
  }
}

/** The token for this browser, minting one on first use. */
export function getPublisherToken(): string | null {
  const storage = readStorage();
  if (!storage) return null;
  try {
    const existing = storage.getItem(TOKEN_KEY);
    if (existing && /^[A-Za-z0-9._-]{16,200}$/.test(existing)) return existing;
    const minted = Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    storage.setItem(TOKEN_KEY, minted);
    return minted;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = getPublisherToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Every call is a soft failure. A deployment with no D1/R2 bindings answers
 * 503, and the header degrades to "Versions unavailable" instead of taking the
 * canvas down with it — the same posture `fetchRuntimeSnapshot()` takes.
 */
async function request<T>(
  path: string,
  init: RequestInit,
  pick: (body: Record<string, unknown>) => T,
): Promise<VersionsResult<T>> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: { ...authHeaders(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || body.ok !== true) {
      return { ok: false, reason: typeof body.error === 'string' ? body.error : `Request failed (${response.status}).` };
    }
    return { ok: true, value: pick(body) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Version service is unreachable.' };
  }
}

export function listVersions(): Promise<VersionsResult<AppVersion[]>> {
  return request('/api/versions', { method: 'GET' }, (body) => (body.versions ?? []) as AppVersion[]);
}

export function fetchVersion(id: string): Promise<VersionsResult<AppVersionDetail>> {
  return request(`/api/versions/${encodeURIComponent(id)}`, { method: 'GET' }, (body) => body.version as AppVersionDetail);
}

export interface PublishRequest {
  name: string;
  description?: string;
  starterHash: string;
  files: FileMap;
}

export function publishVersion(input: PublishRequest): Promise<VersionsResult<AppVersion>> {
  return request('/api/versions', { method: 'POST', body: JSON.stringify(input) }, (body) => body.version as AppVersion);
}

export function renameVersion(id: string, patch: { name?: string; description?: string }): Promise<VersionsResult<AppVersion>> {
  return request(
    `/api/versions/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    (body) => body.version as AppVersion,
  );
}

export function unpublishVersion(id: string): Promise<VersionsResult<true>> {
  return request(`/api/versions/${encodeURIComponent(id)}`, { method: 'DELETE' }, () => true as const);
}

/** The `?version=<id>` deep link, used by the macOS shell's `--url` flag. */
export function readVersionParam(search: string): string | null {
  const value = new URLSearchParams(search).get('version');
  return value && /^[0-9a-f]{16}$/.test(value) ? value : null;
}

/** Keeps the address bar in step with the loaded version without a navigation. */
export function writeVersionParam(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('version', id);
  else url.searchParams.delete('version');
  window.history.replaceState(null, '', url);
}
