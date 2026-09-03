import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createImportRelay } from '../lib/health/import-relay';
import type { ImportProgressReport } from '../lib/health/import';

/**
 * The relay is the whole ordering contract between a running import and the
 * guest's progress view: the guest switches to the record explorer on
 * `import.started` and leaves it on `import.finished`, so an event out of order
 * is a view showing the wrong thing, not a cosmetic glitch.
 */

function report(over: Partial<ImportProgressReport> = {}): ImportProgressReport {
  return {
    completedSearches: 1,
    totalSearches: 27,
    resourceCount: 10,
    attachmentCount: 0,
    ...over,
  };
}

function setup(intervalMs = 200) {
  const events: { event: string; payload?: unknown }[] = [];
  const reports: (ImportProgressReport | undefined)[] = [];
  const relay = createImportRelay({
    emit: (event, payload) => { events.push({ event, payload }); },
    onReport: (value) => { reports.push(value); },
    intervalMs,
  });
  return { relay, events, reports };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('import relay', () => {
  it('announces the start with the provider being imported from', () => {
    const { relay, events } = setup();
    relay.start('ucsf', 'UCSF Health');
    expect(events).toEqual([{ event: 'import.started', payload: { providerId: 'ucsf', providerName: 'UCSF Health' } }]);
  });

  it('emits nothing before a start', () => {
    // Sign-in can fail or be abandoned, and the guest never left the landing
    // page in that case. Progress or a finish there would move it for nothing.
    const { relay, events } = setup();
    relay.progress(report());
    relay.finish({ ok: false, error: 'Sign-in timed out.' });
    expect(events).toEqual([]);
  });

  it('collapses a burst of reports into one event per interval', () => {
    const { relay, events } = setup();
    relay.start('ucsf', 'UCSF Health');
    for (let index = 1; index <= 50; index += 1) relay.progress(report({ resourceCount: index }));

    vi.advanceTimersByTime(200);
    const progress = events.filter((entry) => entry.event === 'import.progress');
    // Every page of every search reports; one postMessage each would be hundreds.
    expect(progress).toHaveLength(1);
    // And the one that lands is the newest, not the first of the burst.
    expect((progress[0].payload as ImportProgressReport).resourceCount).toBe(50);
  });

  it('keeps emitting while reports keep arriving', () => {
    const { relay, events } = setup();
    relay.start('ucsf', 'UCSF Health');
    relay.progress(report({ resourceCount: 1 }));
    vi.advanceTimersByTime(200);
    relay.progress(report({ resourceCount: 2 }));
    vi.advanceTimersByTime(200);

    expect(events.filter((entry) => entry.event === 'import.progress')).toHaveLength(2);
  });

  it('flushes the final counts before the finish', () => {
    const { relay, events } = setup();
    relay.start('ucsf', 'UCSF Health');
    relay.progress(report({ resourceCount: 4210, completedSearches: 27 }));
    relay.finish({ ok: true });

    expect(events.map((entry) => entry.event)).toEqual([
      'import.started',
      'import.progress',
      'import.finished',
    ]);
    expect((events[1].payload as ImportProgressReport).resourceCount).toBe(4210);
  });

  it('emits nothing after a finish', () => {
    // A pending throttled report arriving after the record has replaced the
    // panel would reopen it.
    const { relay, events } = setup();
    relay.start('ucsf', 'UCSF Health');
    relay.progress(report());
    relay.finish({ ok: true });
    const settled = events.length;

    relay.progress(report({ resourceCount: 99 }));
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(settled);
  });

  it('carries the failure to the guest, which may have navigated away', () => {
    const { relay, events } = setup();
    relay.start('ucsf', 'UCSF Health');
    relay.finish({ ok: false, error: 'Sign-in timed out.' });
    expect(events.at(-1)).toEqual({
      event: 'import.finished',
      payload: { ok: false, error: 'Sign-in timed out.' },
    });
  });

  it('finishes once, however many times it is told to', () => {
    const { relay, events } = setup();
    relay.start('ucsf', 'UCSF Health');
    relay.finish({ ok: true });
    relay.finish({ ok: true });
    expect(events.filter((entry) => entry.event === 'import.finished')).toHaveLength(1);
  });

  it('starts the next run without waiting out the previous interval', () => {
    const { relay, events, reports } = setup();
    relay.start('ucsf', 'UCSF Health');
    relay.progress(report());
    vi.advanceTimersByTime(200);
    relay.finish({ ok: true });

    relay.start('sutter', 'Sutter Health');
    // Host chrome is cleared so a second import does not open showing the
    // first one's counts.
    expect(reports.at(-1)).toBeUndefined();
    relay.progress(report({ resourceCount: 3 }));
    vi.advanceTimersByTime(0);
    expect((events.at(-1)?.payload as ImportProgressReport).resourceCount).toBe(3);
  });
});
