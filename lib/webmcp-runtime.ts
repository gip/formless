'use client';

import { BRIDGE_PROTOCOL, type RouteDescriptor, type SpeechState, type UiElementDescriptor } from './canvas-types';
import { UserMessageQueue } from './message-queue';
import { getProjectController } from './project-controller';
import { createSpeechPort } from './speech';
import { createCanvasTools, registerNativeTools, type VersionOperations } from './webmcp-tools';

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

function versions(): VersionOperations {
  if (!versionOperations) throw new Error('Version controls are not ready yet.');
  return versionOperations;
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
  versions: {
    list: () => versions().list(),
    publish: (input) => versions().publish(input),
    switchTo: (baseRevision, versionId) => versions().switchTo(baseRevision, versionId),
    current: () => versions().current(),
  },
});

/**
 * Registered once, at import. Never disposed: the tools are valid for the life
 * of the document, and tearing them down on a React lifecycle is what left a
 * window where the tool list was empty.
 */
const native = typeof document === 'undefined' ? false : registerNativeTools(canvasTools).native;

/**
 * Whether the tools reached a real `document.modelContext`. Read through
 * `useSyncExternalStore` rather than rendered directly: this is false during
 * SSR and true in the browser, which is a hydration mismatch if a component
 * reads it at first render.
 */
export function isNativeWebMcp(): boolean {
  return native;
}

/** The value never changes after import, so there is nothing to subscribe to. */
export function subscribeNativeWebMcp(): () => void {
  return () => undefined;
}
