'use client';

import type { AuthStatus, HealthPort, HealthSnapshot } from '../host-capabilities';
import { loadDemoRecord } from './demo-record';
import { PROVIDERS } from './providers';
import {
  clearRecord,
  loadRecord,
  lockRecord,
  recordState,
  storedProvider,
  unlockRecord,
} from './storage';
import type { HealthExportDocument } from './types';

/**
 * The host's implementation of the guest's health capability.
 *
 * Everything sensitive stops here. The access token and the storage key live in
 * this module and in host-origin IndexedDB; the guest only ever receives a
 * decrypted `HealthExportDocument` over the bridge. That is the point of the
 * split — `guest/src/**` is rewritable by an agent, so it must not be able to
 * leak, or be tricked into leaking, credentials.
 *
 * With no Epic client id configured this degrades the way the versions API
 * already does: everything answers, `configured` is false, and the demo record
 * stands in for a real one. `AGENTS.md`: never make the canvas depend on the
 * backend being present.
 */

export interface HealthHostHooks {
  /** Asks the user for a storage passphrase in host chrome. Null means cancelled. */
  requestPassphrase: (mode: 'create' | 'unlock') => Promise<string | null>;
  /** Runs the OAuth + import round trip. Resolves once a record is stored. */
  runConnect: (params: {
    providerId: string;
    includeAttachments: boolean;
    passphrase: string;
    /** Called when the download itself begins, after sign-in returns a token. */
    onImportStart: () => void;
  }) => Promise<HealthExportDocument>;
  /** Notifies the guest that auth or record state moved underneath it. */
  emit: (event: string, payload?: unknown) => void;
}

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` into the client bundle by *static*
 * text substitution, so every variable has to appear as a literal member access
 * somewhere. A dynamic `process.env[name]` is never substituted and reads as
 * undefined in the browser — which would fail exactly the way this module warns
 * about below: silently, with the connect panel claiming nothing is configured.
 *
 * Rebuilt on each call rather than hoisted to a module constant so `vi.stubEnv`
 * still works in tests, which stub after the module has been imported.
 */
function clientEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_EPIC_CLIENT_ID: process.env.NEXT_PUBLIC_EPIC_CLIENT_ID,
    NEXT_PUBLIC_EPIC_SANDBOX_CLIENT_ID: process.env.NEXT_PUBLIC_EPIC_SANDBOX_CLIENT_ID,
    NEXT_PUBLIC_EPIC_SCOPE: process.env.NEXT_PUBLIC_EPIC_SCOPE,
  };
}

function envValue(name: string): string | null {
  const value = clientEnv()[name];
  return typeof value === 'string' && value ? value : null;
}

/**
 * A PKCE client id is public by construction (there is no secret in this flow),
 * so it ships as a public env var — the same posture as
 * NEXT_PUBLIC_WEBCONTAINER_API_KEY.
 *
 * Epic issues *separate* non-production and production client ids for the same
 * app, so the sandbox provider takes its own when one is set. Sending a
 * production id to the sandbox authorize endpoint just fails, unhelpfully.
 */
export function epicClientId(providerId?: string): string | null {
  if (providerId === 'epic-sandbox') {
    return envValue('NEXT_PUBLIC_EPIC_SANDBOX_CLIENT_ID') ?? envValue('NEXT_PUBLIC_EPIC_CLIENT_ID');
  }
  return envValue('NEXT_PUBLIC_EPIC_CLIENT_ID');
}

export function epicScope(): string | null {
  return envValue('NEXT_PUBLIC_EPIC_SCOPE');
}

/** Provider ids with a usable client id. */
export function configuredProviders(): string[] {
  return Object.keys(PROVIDERS).filter((id) => epicClientId(id) !== null);
}

export function isEpicConfigured(): boolean {
  // Any provider will do. Reading only NEXT_PUBLIC_EPIC_CLIENT_ID here meant that
  // configuring *just* the sandbox left the whole panel disabled.
  return configuredProviders().length > 0;
}

export function createHealthPort(hooks: HealthHostHooks): HealthPort {
  /** Mirrors the store, so `status()` stays synchronous for the common case. */
  let cachedRecord: HealthExportDocument | undefined;
  /**
   * True from the first FHIR request until the record is stored. The store is
   * still `empty` for that whole window, so without this `getRecord()` would
   * answer with the de-identified sample — and the guest, which switches to the
   * record view when the download starts, would show a stranger's data under
   * the patient's own heading. Refusing here rather than in the guest keeps it
   * true for guest code an agent rewrote.
   *
   * Deliberately not set for the whole of `connect()`: while the user is still
   * signing in, nothing has changed and the sample record is still the honest
   * answer to `getRecord()`.
   */
  let importing = false;

  async function status(): Promise<AuthStatus> {
    const state = await recordState();
    return {
      configured: isEpicConfigured(),
      configuredProviders: configuredProviders(),
      connected: state !== 'empty',
      provider: await storedProvider(),
      record: state,
    };
  }

  /**
   * The record, and which record it is.
   *
   * `getRecord()` collapses all of this to "a document or nothing", which is
   * all the guest needs. The tools need more: the difference between the
   * user's own history and a de-identified stand-in is the difference between
   * a useful answer and a dangerously wrong one.
   */
  async function currentSnapshot(): Promise<HealthSnapshot> {
    const state = await recordState();
    const base = await status();
    if (importing) return { status: base, source: 'none', reason: 'importing' };
    // Locked means the key is gone from memory. Falling back to the demo record
    // here would quietly show a different person's data under the patient's own
    // heading, so a locked store yields nothing at all.
    if (state === 'locked') return { status: base, source: 'none', reason: 'locked' };
    if (state === 'unlocked') {
      cachedRecord ??= await loadRecord();
      if (cachedRecord) return { status: base, source: 'connected', record: cachedRecord };
    }
    const demo = await loadDemoRecord();
    return demo
      ? { status: base, source: 'sample', record: demo }
      : { status: base, source: 'none', reason: 'unavailable' };
  }

  async function currentRecord(): Promise<HealthExportDocument | undefined> {
    return (await currentSnapshot()).record as HealthExportDocument | undefined;
  }

  return {
    status,

    snapshot: currentSnapshot,

    async connect({ providerId, includeAttachments }) {
      if (epicClientId(providerId) === null) {
        throw new Error(
          `No client id is configured for ${providerId}. Set NEXT_PUBLIC_EPIC_CLIENT_ID, or NEXT_PUBLIC_EPIC_SANDBOX_CLIENT_ID for the Epic Sandbox.`,
        );
      }
      const passphrase = await hooks.requestPassphrase('create');
      if (passphrase === null) throw new Error('Connection cancelled.');

      try {
        cachedRecord = await hooks.runConnect({
          providerId,
          includeAttachments,
          passphrase,
          onImportStart: () => { importing = true; },
        });
      } finally {
        importing = false;
      }
      hooks.emit('record.changed');
      return status();
    },

    async disconnect() {
      cachedRecord = undefined;
      await clearRecord();
      hooks.emit('record.changed');
      return status();
    },

    async getRecord() {
      return currentRecord();
    },

    async unlock() {
      if ((await recordState()) !== 'locked') return status();
      const passphrase = await hooks.requestPassphrase('unlock');
      if (passphrase === null) throw new Error('Unlock cancelled.');
      cachedRecord = await unlockRecord(passphrase);
      hooks.emit('record.changed');
      return status();
    },

    async lock() {
      cachedRecord = undefined;
      lockRecord();
      hooks.emit('record.changed');
      return status();
    },

    async clear() {
      cachedRecord = undefined;
      await clearRecord();
      hooks.emit('record.changed');
      return status();
    },

    async download() {
      const record = await currentRecord();
      if (!record) throw new Error('There is no record to download.');
      const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'health-export.json';
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}
