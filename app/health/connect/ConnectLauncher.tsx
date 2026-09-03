'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { broadcast } from '@/lib/health/session';

/**
 * Announces that the popup is alive, then sends it on to the provider.
 *
 * The heartbeat is what distinguishes "the user is taking their time signing in"
 * from "this browser never opened a window at all" — the macOS shell implements
 * no `createWebViewWith`, so the latter is a real case, not a hypothetical.
 */

type Outcome = { ok: true; url: string } | { ok: false; error: string } | { ok: null };

/** Pure, so the render can decide what to show without an effect writing state. */
export function resolveTarget(search: string): Outcome {
  const target = new URLSearchParams(search).get('to');
  if (!target) return { ok: false, error: 'This window was opened without a sign-in destination.' };

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, error: 'The sign-in destination is not a valid URL.' };
  }
  // Only ever leave for a real provider over TLS. A relative or `javascript:`
  // target here would turn this page into an open redirect off our own origin.
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'The sign-in destination must use HTTPS.' };
  }
  return { ok: true, url: url.toString() };
}

const subscribe = () => () => undefined;

/**
 * Distinguishes "not hydrated yet" from "hydrated, and the query really is
 * empty". Without it a bare `/health/connect` is indistinguishable from the
 * server render and sits on the neutral message forever instead of saying it
 * was opened without a destination.
 */
const NOT_HYDRATED = '\u0000ssr';

export default function ConnectLauncher() {
  // The query string is external state, so it is read through the sanctioned
  // hook rather than by writing it into React state from an effect.
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => NOT_HYDRATED,
  );
  const outcome = useMemo<Outcome>(
    () => (search === NOT_HYDRATED ? { ok: null } : resolveTarget(search)),
    [search],
  );

  useEffect(() => {
    if (outcome.ok !== true) return;
    broadcast({ kind: 'started' });
    window.location.replace(outcome.url);
  }, [outcome]);

  const failed = outcome.ok === false;
  return (
    <main className="health-callback">
      <h1>{failed ? 'Could not start sign-in' : 'Taking you to your provider…'}</h1>
      <p>
        {failed
          ? outcome.error
          : 'You can close this window if it does not continue on its own.'}
      </p>
    </main>
  );
}
