'use client';

import type { AuthStatus, HealthPort, HealthSnapshot } from '../host-capabilities';
import { loadDemoRecord } from './demo-record';
import { PROVIDERS } from './providers';
import { listProviderChoices } from './registry';
import {
  clearRecord,
  loadRecord,
  lockRecord,
  recordState,
  storedProvider,
  unlockRecord,
  type RecordState,
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
 * already does: everything answers, `configured` is false, and the explorer is
 * still reviewable — via the de-identified sample, which the user asks for by
 * name. `AGENTS.md`: never make the canvas depend on the backend being present.
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

/**
 * Curated provider ids with a usable client id.
 *
 * Only ever answers for `PROVIDERS`, which is why it is not what the guest is
 * told: an organization resolved from Epic's directory is not a member, and
 * membership was never the question anyway. `epicCredentials()` is the wire
 * answer; this stays because it is the honest per-id statement and is what
 * `tests/health-config.test.ts` pins.
 */
export function configuredProviders(): string[] {
  return Object.keys(PROVIDERS).filter((id) => epicClientId(id) !== null);
}

/**
 * Which client ids exist, by environment.
 *
 * Every production organization shares one client id — Epic registers the app
 * once — so this is two booleans regardless of how many organizations the
 * directory carries.
 */
export function epicCredentials(): { production: boolean; sandbox: boolean } {
  return {
    production: epicClientId('ucsf') !== null,
    sandbox: epicClientId('epic-sandbox') !== null,
  };
}

export function isEpicConfigured(): boolean {
  // Any provider will do. Reading only NEXT_PUBLIC_EPIC_CLIENT_ID here meant that
  // configuring *just* the sandbox left the whole panel disabled.
  const credentials = epicCredentials();
  return credentials.production || credentials.sandbox;
}

export function createHealthPort(hooks: HealthHostHooks): HealthPort {
  /** Mirrors the store, so `status()` stays synchronous for the common case. */
  let cachedRecord: HealthExportDocument | undefined;
  /**
   * True from the first FHIR request until the record is stored. The store is
   * still `empty` for that whole window, so without this a user who had the
   * sample on screen would keep it there — a stranger's data under the
   * patient's own heading, while their own download runs. Refusing here rather
   * than in the guest keeps it true for guest code an agent rewrote.
   *
   * Deliberately not set for the whole of `connect()`: while the user is still
   * signing in, nothing has been downloaded and whatever they were looking at
   * is still the honest answer to `getRecord()`.
   */
  let importing = false;
  /**
   * Whether the user has asked to see the de-identified sample.
   *
   * The sample used to be served automatically whenever the store was empty,
   * which made it the default content of `/explore` — so anything that put a
   * fresh guest on that route showed a stranger's history under the same
   * headings a real import uses. A version switch does exactly that: it
   * rewrites `src/**`, Vite full-reloads the guest, and the reload restores
   * `#/explore` from the iframe's own URL.
   *
   * Now nothing but `showSample(true)` turns it on, and it is a per-session
   * decision: it is not persisted, and anything that produces a real record —
   * or removes one — turns it back off.
   */
  let sampleVisible = false;

  /**
   * The one place that decides whether the sample is on screen, so `status()`
   * and `currentSnapshot()` cannot disagree about it. An import in flight or a
   * record on disk always outranks the request.
   */
  function showingSample(state: RecordState): boolean {
    return sampleVisible && !importing && state === 'empty';
  }

  async function status(): Promise<AuthStatus> {
    const state = await recordState();
    return {
      configured: isEpicConfigured(),
      credentials: epicCredentials(),
      connected: state !== 'empty',
      provider: await storedProvider(),
      record: state,
      sample: showingSample(state),
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
      // A store that says it is unlocked and will not decrypt is broken, not
      // empty. This used to fall through to the sample, and because `connected`
      // is true for any non-empty store the explorer then captioned a
      // stranger's history "Your imported record" — the exact confusion the
      // locked branch above refuses to create.
      return cachedRecord
        ? { status: base, source: 'connected', record: cachedRecord }
        : { status: base, source: 'none', reason: 'unavailable' };
    }
    // Nothing stored. The sample is a thing the user asks for, never the
    // default answer — see `sampleVisible`.
    if (!showingSample(state)) return { status: base, source: 'none', reason: 'empty' };
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

    // Public reference data — organization names and FHIR base URLs — but it
    // rides under `auth.` and so inherits `requiresPrivilege`. That is the
    // consistent choice: a version published by someone else already cannot
    // call `auth.status`, so its connect panel is dark either way.
    providers: listProviderChoices,

    async connect({ providerId, includeAttachments }) {
      if (epicClientId(providerId) === null) {
        throw new Error(
          `No client id is configured for ${providerId}. Set NEXT_PUBLIC_EPIC_CLIENT_ID, or NEXT_PUBLIC_EPIC_SANDBOX_CLIENT_ID for the Epic Sandbox.`,
        );
      }
      const passphrase = await hooks.requestPassphrase('create');
      if (passphrase === null) throw new Error('Connection cancelled.');

      // The user's own record is about to arrive; the stand-in has no more work
      // to do, and leaving it armed would put it back on screen if this fails.
      sampleVisible = false;
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
      sampleVisible = false;
      await clearRecord();
      hooks.emit('record.changed');
      return status();
    },

    async getRecord() {
      return currentRecord();
    },

    /**
     * The sample is shown only from here, and only ever because a person
     * clicked the control that calls it. It is refused outright once a record
     * exists in this browser: the explorer would not show it anyway, and
     * answering `true` would leave the guest rendering a caption for something
     * that is not on screen.
     */
    async showSample(show) {
      sampleVisible = show && (await recordState()) === 'empty';
      hooks.emit('record.changed');
      return status();
    },

    async unlock() {
      if ((await recordState()) !== 'locked') return status();
      const passphrase = await hooks.requestPassphrase('unlock');
      if (passphrase === null) throw new Error('Unlock cancelled.');
      cachedRecord = await unlockRecord(passphrase);
      sampleVisible = false;
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
      // Removing your data must not hand you someone else's in its place.
      sampleVisible = false;
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
