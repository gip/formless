'use client';

import { BRIDGE_PROTOCOL, type RouteDescriptor, type SpeechState, type UiElementDescriptor } from './canvas-types';
import { UserMessageQueue } from './message-queue';
import { getProjectController } from './project-controller';
import { createSpeechPort } from './speech';
import { createCanvasTools, registerNativeTools, type HealthAccess, type VersionOperations } from './webmcp-tools';

/**
 * Registers the WebMCP tools as this module is evaluated, before React hydrates.
 *
 * Registration used to live in a `useEffect`, which meant an agent connecting
 * at load found an empty tool list until hydration finished — measured at
 * ~270ms against a local dev server, and worse anywhere slower. Nothing about a
 * tool *descriptor* needs React: only its execution needs the live page. So the
 * mutable pieces live here as plain module state that `CanvasApp` fills in, and
 * the descriptors read them at call time.
 */

/** Typed input and final speech transcripts. `poll_user_messages` is the only reader. */
export const messageQueue = new UserMessageQueue(50);

/**
 * The page's own voice, driving `speak_text` and the header voice control.
 * Constructed with no synthesizer during SSR, where it simply reports itself as
 * unsupported.
 */
export const speechPort = createSpeechPort(
  typeof window === 'undefined' ? null : undefined,
);

/** Frozen so `useSyncExternalStore` has a stable server snapshot to compare. */
const speechServerState: SpeechState = Object.freeze({
  supported: false,
  armed: false,
  speaking: false,
  blocked: false,
  lastError: null,
});

export function getSpeechState(): SpeechState {
  return speechPort.getState();
}

export function getServerSpeechState(): SpeechState {
  return speechServerState;
}

export function subscribeSpeech(listener: () => void): () => void {
  return speechPort.subscribe(listener);
}

let previewTarget: { window: Window; origin: string } | null = null;
let elements: UiElementDescriptor[] = [];
let versionOperations: VersionOperations | null = null;
/**
 * The record and the capability grant, filled in by `CanvasApp`. Null until it
 * mounts: `createHealthPort` needs the passphrase prompt and the import relay,
 * neither of which exists at module evaluation.
 */
let healthAccess: HealthAccess | null = null;
/** Routes the guest declared via `manifest`. Empty until it does — never guessed. */
let routes: RouteDescriptor[] = [];

export function setPreviewTarget(target: { window: Window; origin: string } | null): void {
  previewTarget = target;
}

export function setElements(next: UiElementDescriptor[]): void {
  elements = next;
}

export function setVersionOperations(operations: VersionOperations | null): void {
  versionOperations = operations;
}

export function setRoutes(next: RouteDescriptor[]): void {
  routes = next;
}

export function setHealthAccess(next: HealthAccess | null): void {
  healthAccess = next;
}

function versions(): VersionOperations {
  if (!versionOperations) throw new Error('Version controls are not ready yet.');
  return versionOperations;
}

function health(): HealthAccess {
  if (!healthAccess) throw new Error('The health record is not ready yet.');
  return healthAccess;
}

export type PreviewCommand = 'highlight' | 'clear-highlight' | 'host-response' | 'host-event';

export function sendPreviewCommand(type: PreviewCommand, payload: Record<string, unknown> = {}): void {
  if (!previewTarget) throw new Error('The live preview is not ready.');
  previewTarget.window.postMessage({ protocol: BRIDGE_PROTOCOL, type, payload }, previewTarget.origin);
}

export const canvasTools = createCanvasTools({
  project: getProjectController(),
  messages: messageQueue,
  getElements: () => elements,
  getRoutes: () => routes,
  sendPreviewCommand,
  speech: speechPort,
  health: {
    snapshot: () => health().snapshot(),
    grant: () => health().grant(),
  },
  versions: {
    list: () => versions().list(),
    publish: (input) => versions().publish(input),
    switchTo: (baseRevision, versionId) => versions().switchTo(baseRevision, versionId),
    current: () => versions().current(),
  },
});

/**
 * Registration is one-shot *per success*, never disposed: the tools are valid
 * for the life of the document, and tearing them down on a React lifecycle is
 * what left a window where the tool list was empty.
 *
 * It is not one-shot per *attempt*, though. `document.modelContext` is put
 * there by something outside the page — the macOS shell's polyfill at document
 * start, or a browser extension's bridge — and an extension may not attach
 * until the user grants the origin, or until the tab is first activated. That
 * lands after this module evaluates, and a single attempt at import silently
 * registers nothing: `native` stays false for the life of the page, the guest
 * composer is told over `mcp.status` that no agent is attached, and only a full
 * reload recovers. So a failed attempt starts a watcher and retries.
 */
let native = false;
const nativeListeners = new Set<() => void>();

/** Idempotent: the first success wins and every later call is a no-op, so the
 *  tools are registered exactly once however many times the watcher fires. */
function attemptRegistration(): boolean {
  if (native) return true;
  if (!registerNativeTools(canvasTools).native) return false;
  native = true;
  for (const listener of [...nativeListeners]) listener();
  return true;
}

/**
 * Polls for a late `document.modelContext`, fast at first for the ordinary
 * injection race, then slowly. Tab activation and window focus are when an
 * extension typically attaches, so each one retries immediately and buys
 * another full budget — an origin granted an hour into the session still gets
 * picked up, without leaving a timer running forever on a plain browser that
 * is never going to have WebMCP at all.
 */
function watchForModelContext(): void {
  const FAST_INTERVAL_MS = 200;
  const SLOW_INTERVAL_MS = 2_000;
  const FAST_PHASE_MS = 10_000;
  const BUDGET_MS = 60_000;

  let timer: number | null = null;
  let startedAt = Date.now();

  const stop = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('pageshow', wake);
  };

  const tick = () => {
    timer = null;
    if (attemptRegistration()) return stop();
    const elapsed = Date.now() - startedAt;
    if (elapsed >= BUDGET_MS) return; // Listeners stay; they are free and can restart it.
    timer = window.setTimeout(tick, elapsed < FAST_PHASE_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS);
  };

  function wake() {
    if (native) return stop();
    startedAt = Date.now();
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(tick, 0);
  }

  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  timer = window.setTimeout(tick, FAST_INTERVAL_MS);
}

if (typeof document !== 'undefined' && !attemptRegistration()) watchForModelContext();

/**
 * Whether the tools reached a real `document.modelContext`. Read through
 * `useSyncExternalStore` rather than rendered directly: this is false during
 * SSR and true in the browser, which is a hydration mismatch if a component
 * reads it at first render — and it can now flip from false to true long after
 * hydration, when a bridge attaches late.
 */
export function isNativeWebMcp(): boolean {
  return native;
}

/** Fires once, if and when a late-arriving bridge takes the registration. */
export function subscribeNativeWebMcp(listener: () => void): () => void {
  nativeListeners.add(listener);
  return () => nativeListeners.delete(listener);
}
