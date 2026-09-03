import { useSyncExternalStore } from 'react';

import { onHostEvent } from '../agent/bridge';

/**
 * What the host is doing while it imports a record.
 *
 * The app cannot observe the download itself — the token, the FHIR requests and
 * the encryption all live on the host, which is the point. So the host narrates
 * it over three `host-event`s (`import.started`, `import.progress`,
 * `import.finished`) and this module turns them into one piece of state the
 * views can read.
 *
 * A module-level store rather than a hook's own state because two places need
 * the same answer: `App` decides where to send the user when a download starts,
 * and `ExploreView` renders the progress. `useSyncExternalStore` keeps them in
 * step without a provider.
 */

export interface ImportProgress {
  completedSearches: number;
  totalSearches: number;
  resourceCount: number;
  attachmentCount: number;
  /** The resource type most recently receiving data, when the host named one. */
  label?: string;
}

export interface ImportState {
  /** True while the host is downloading. The record view follows this. */
  active: boolean;
  /** Absent until the first counts arrive — sign-in ends before any data moves. */
  progress?: ImportProgress;
  /** The provider being imported from, as the host identified it. */
  providerId?: string;
  /** Why the last import stopped, when it failed. Cleared when the next one starts. */
  error?: string;
}

const IDLE: ImportState = { active: false };

let state: ImportState = IDLE;
const listeners = new Set<() => void>();

function set(next: ImportState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function asProgress(payload: unknown): ImportProgress | undefined {
  const value = payload as Partial<ImportProgress> | undefined;
  if (!value || typeof value.resourceCount !== 'number') return undefined;
  return {
    completedSearches: value.completedSearches ?? 0,
    totalSearches: value.totalSearches ?? 0,
    resourceCount: value.resourceCount,
    attachmentCount: value.attachmentCount ?? 0,
    ...(value.label ? { label: value.label } : {}),
  };
}

/**
 * True between `import.finished` and the record reaching the view. Gating
 * `importSettled()` on it is what stops a record fetched *during* the import
 * from closing the panel — mid-import the only record on offer is the sample,
 * and swapping the patient's progress for a stranger's data is the failure this
 * whole path exists to avoid.
 */
let awaitingRecord = false;

/**
 * The success path's backstop. `ExploreView` normally ends the run the moment it
 * has the record; this only matters when nothing is listening — the user never
 * opened the record view, or a rewritten app dropped the call.
 */
const SETTLE_TIMEOUT_MS = 30_000;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function stopSettleTimer(): void {
  clearTimeout(settleTimer);
  settleTimer = undefined;
}

/** Ends the run once the imported record is on screen. A no-op otherwise. */
export function importSettled(): void {
  if (!awaitingRecord) return;
  awaitingRecord = false;
  stopSettleTimer();
  set(IDLE);
}

// Subscribed at module scope, not from a component: `import.started` arrives
// before anything that renders progress is mounted — that event is the reason
// the record view gets mounted at all.
onHostEvent('import.started', (payload) => {
  const providerId = (payload as { providerId?: unknown } | undefined)?.providerId;
  awaitingRecord = false;
  stopSettleTimer();
  set({ active: true, ...(typeof providerId === 'string' ? { providerId } : {}) });
});

onHostEvent('import.progress', (payload) => {
  // Ignored unless a start is outstanding, so a late throttled report cannot
  // reopen a panel the finished record has already replaced.
  if (!state.active) return;
  const progress = asProgress(payload);
  if (progress) set({ ...state, progress });
});

onHostEvent('import.finished', (payload) => {
  if (!state.active) return;
  const result = payload as { ok?: unknown; error?: unknown } | undefined;
  const error = typeof result?.error === 'string' ? result.error : undefined;
  if (result?.ok === false) {
    awaitingRecord = false;
    stopSettleTimer();
    set({ active: false, ...(error ? { error } : {}) });
    return;
  }
  // On success the panel stays up: the record still has to cross the bridge,
  // and `ExploreView` calls `importSettled()` once it has it. Dropping straight
  // to idle here would flash an empty explorer in between.
  awaitingRecord = true;
  settleTimer = setTimeout(importSettled, SETTLE_TIMEOUT_MS);
});

export function useImportState(): ImportState {
  return useSyncExternalStore(subscribe, () => state, () => IDLE);
}
