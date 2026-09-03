import type { ImportProgressReport } from './import';

/**
 * Turns `connectAndImport`'s progress callbacks into host events the guest can
 * render.
 *
 * Two reasons this is a module rather than three lines inside `CanvasApp`.
 * First, `exportPatientRecord` reports on every *page* of every search, which
 * for a real record is hundreds of callbacks — each one a `postMessage` across
 * the bridge and a host re-render if left unthrottled. Second, the ordering
 * rules below are the whole correctness story of the feature and are worth
 * pinning in a test: no progress before a start, none after a finish, and the
 * last report always lands.
 *
 * It takes its emitter and its interval as arguments for the same reason
 * `createSpeechPort` takes a synthesizer — so `tests/import-relay.test.ts` can
 * drive it under the node environment.
 */

export interface ImportRelayHooks {
  /** Sends a `host-event` to the preview. */
  emit: (event: string, payload?: unknown) => void;
  /** Mirrors the latest report into host chrome. */
  onReport: (report: ImportProgressReport | undefined) => void;
  /** Minimum gap between emitted progress events. */
  intervalMs?: number;
}

export type ImportResult = { ok: true } | { ok: false; error: string };

export interface ImportRelay {
  /** The download has begun. The guest treats this as "switch to the record view". */
  start: (providerId: string) => void;
  progress: (report: ImportProgressReport) => void;
  /** Ends the run. A finish without a start emits nothing: sign-in never got that far. */
  finish: (result: ImportResult) => void;
}

const DEFAULT_INTERVAL_MS = 200;

export function createImportRelay({
  emit,
  onReport,
  intervalMs = DEFAULT_INTERVAL_MS,
}: ImportRelayHooks): ImportRelay {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: ImportProgressReport | undefined;
  let sentAt = 0;
  let running = false;

  function send(): void {
    timer = undefined;
    sentAt = Date.now();
    onReport(latest);
    emit('import.progress', latest);
  }

  function cancelPending(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  return {
    start(providerId) {
      cancelPending();
      running = true;
      latest = undefined;
      // Not `Date.now()`: the first report of a run should go out immediately,
      // however recently the previous run finished.
      sentAt = 0;
      onReport(undefined);
      emit('import.started', { providerId });
    },

    progress(report) {
      if (!running) return;
      latest = report;
      // A timer already pending is the trailing edge of the current window; it
      // will pick up whatever `latest` holds when it fires, so the newest report
      // is never the one that gets dropped.
      if (timer !== undefined) return;
      timer = setTimeout(send, Math.max(0, intervalMs - (Date.now() - sentAt)));
    },

    finish(result) {
      cancelPending();
      if (!running) return;
      running = false;
      // The guest hides its progress panel on `import.finished`, so the last
      // numbers have to be in hand before it arrives — a throttled report
      // landing afterwards would reopen a panel the record has already replaced.
      if (latest) {
        onReport(latest);
        emit('import.progress', latest);
      }
      emit('import.finished', result);
    },
  };
}
