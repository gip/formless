'use client';

import type { StatePort } from './host-capabilities';

/**
 * Host-owned key/value storage for the guest app.
 *
 * The guest's own IndexedDB is useless for anything that should outlive a
 * session: the WebContainer preview gets a fresh origin on every boot, so guest
 * storage is silently wiped each time. Keeping it host-side on a stable origin
 * is what makes "remember which resource group I was reading" survive a reload,
 * a version switch, and a container restart.
 *
 * Scopes come from `computeGrant()` and partition versions from each other, so
 * one published version cannot read another's keys.
 */

const PREFIX = 'webally-guest-state';

function storageKey(scope: string, key: string): string {
  return `${PREFIX}/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`;
}

function scopePrefix(scope: string): string {
  return `${PREFIX}/${encodeURIComponent(scope)}/`;
}

/**
 * Storage can throw outright — Safari private mode, a browser set to block site
 * data, or a full quota. Guest state is a convenience, never correctness, so
 * every path degrades to "nothing stored" rather than breaking the preview.
 */
function withStorage<T>(fallback: T, run: (storage: Storage) => T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    return run(localStorage);
  } catch {
    return fallback;
  }
}

export const guestStatePort: StatePort = {
  async get(scope, key) {
    return withStorage<unknown>(undefined, (storage) => {
      const raw = storage.getItem(storageKey(scope, key));
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        // A value written by an older or broken build is not worth surfacing.
        return undefined;
      }
    });
  },

  async set(scope, key, value) {
    withStorage(undefined, (storage) => {
      storage.setItem(storageKey(scope, key), JSON.stringify(value ?? null));
    });
  },

  async delete(scope, key) {
    withStorage(undefined, (storage) => {
      storage.removeItem(storageKey(scope, key));
    });
  },

  async keyCount(scope) {
    return withStorage(0, (storage) => {
      const prefix = scopePrefix(scope);
      let count = 0;
      for (let index = 0; index < storage.length; index += 1) {
        if (storage.key(index)?.startsWith(prefix)) count += 1;
      }
      return count;
    });
  },
};
