'use client';

/**
 * Whether a WebMCP client has actually *done* anything on this page.
 *
 * `document.modelContext` existing only means some runtime injected a bridge —
 * the macOS shell injects its polyfill at document start for every frame,
 * whether or not a session is attached, and an extension attaches on origin
 * grant rather than on an agent showing up. So bridge presence is not evidence
 * of an agent, and the composer that renders on the strength of it can be a
 * text box wired to nobody.
 *
 * The draft protocol offers no signal for the thing we actually want: there is
 * no event when a host enumerates the registry, no callback per describe, no
 * disconnect. The one moment a client is unambiguously real is when it *calls*
 * a tool, because that runs our own code. So this counts calls, and the UI
 * treats the first one as proof.
 *
 * Deliberately sticky: it answers "has an agent used this page", not "is one
 * looking right now". Nothing in the protocol reports a client leaving, so an
 * expiry here would be a guess dressed as a fact. `lastToolAt` is exposed for
 * anything that wants to say how long ago instead.
 */
export interface AgentActivity {
  /** True once any tool has been executed. Never goes back to false. */
  seen: boolean;
  /** Total tool executions this document has served. */
  calls: number;
  /** `Date.now()` of the most recent call, or null before the first. */
  lastToolAt: number | null;
  /** Name of the most recent tool called, or null before the first. */
  lastToolName: string | null;
}

const listeners = new Set<() => void>();

let activity: AgentActivity = { seen: false, calls: 0, lastToolAt: null, lastToolName: null };

/** Frozen so `useSyncExternalStore` has a stable server snapshot to compare. */
const serverActivity: AgentActivity = Object.freeze({
  seen: false,
  calls: 0,
  lastToolAt: null,
  lastToolName: null,
});

/**
 * Called by the `tool()` wrapper in webmcp-tools for every execution, including
 * ones that go on to throw: a call that fails still proves someone made it.
 */
export function noteToolCall(name: string): void {
  activity = {
    seen: true,
    calls: activity.calls + 1,
    lastToolAt: Date.now(),
    lastToolName: name,
  };
  for (const listener of [...listeners]) listener();
}

export function getAgentActivity(): AgentActivity {
  return activity;
}

export function getServerAgentActivity(): AgentActivity {
  return serverActivity;
}

/**
 * The identity that matters to the UI, split out so `useSyncExternalStore` has
 * a primitive snapshot. Reading the whole object there would hand React a new
 * reference on every call and loop.
 */
export function hasAgentActed(): boolean {
  return activity.seen;
}

export function subscribeAgentActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. Nothing in the app resets a document's history. */
export function resetAgentActivity(): void {
  activity = { seen: false, calls: 0, lastToolAt: null, lastToolName: null };
  for (const listener of [...listeners]) listener();
}
