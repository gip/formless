export const BRIDGE_PROTOCOL = 'webmcp-canvas/v1' as const;

export type RuntimePhase =
  | 'idle'
  | 'restoring'
  | 'booting'
  | 'hydrating'
  | 'mounting'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'validating'
  | 'error';

export type FileMap = Record<string, string>;

export interface ProjectFileDescriptor {
  path: string;
  editable: boolean;
  bytes: number;
  hash: string;
}

export interface ProjectChange {
  path: string;
  operation: 'write' | 'delete';
  content?: string;
}

export interface UiElementDescriptor {
  id: string;
  label: string;
  description: string;
  role: string;
  visible: boolean;
  enabled: boolean;
  kind: string;
}

/**
 * A published app version. Only the editable overlay is stored — every
 * protected file is re-derived from `STARTER_FILES`, so a version can never
 * carry a modified bridge, `package.json`, or build script.
 */
export interface AppVersion {
  id: string;
  name: string;
  description: string;
  contentHash: string;
  authorLabel: string;
  /** True when this browser's publisher token owns the version. */
  mine: boolean;
  /** `starterPackageHash()` at publish time; a mismatch is a warning, not a block. */
  starterHash: string;
  fileCount: number;
  bytes: number;
  createdAt: string;
}

export interface AppVersionDetail extends AppVersion {
  files: FileMap;
}

export interface UserMessage {
  id: number;
  text: string;
  source: 'typed' | 'speech';
  createdAt: string;
}

/**
 * A route the guest app says it can render. Declared by the guest on mount via
 * the `manifest` message, and the source of truth for `navigate_to_route` — the
 * host never guesses what the guest can display.
 */
export interface RouteDescriptor {
  /** Canonical path, e.g. `/explore`. The hash router is transport, not identity. */
  path: string;
  title: string;
  description: string;
}

export interface GuestManifest {
  routes: RouteDescriptor[];
  /** Capability names the guest would like. The host decides what it actually gets. */
  capabilities: string[];
}

export interface HostRequestMessage {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface HostResponseMessage {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface HostEventMessage {
  event: string;
  payload?: unknown;
}

/**
 * What the currently loaded guest is allowed to ask the host for.
 *
 * A published version is someone else's code running in your browser, so this
 * mirrors the rule `previewAllow` already applies to the microphone: your own
 * work is trusted, a stranger's is not. `scope` additionally partitions
 * `state.*` so one version can never read another's stored state.
 */
export interface CapabilityGrant {
  /** State namespace: a version id, or `starter`. */
  scope: string;
  /** True for the starter and for versions this browser published. Gates `auth.*` and `record.*`. */
  privileged: boolean;
}

/** A synthesis voice the host can speak with, as reported to the agent. */
export interface SpeechVoiceDescriptor {
  name: string;
  lang: string;
  default: boolean;
}

export interface SpeakRequest {
  text: string;
  /** Exact voice name from `SpeechVoiceDescriptor.name`. */
  voice?: string;
  /** BCP-47 tag used to pick a voice when `voice` is not given. */
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  /** Cancel anything already speaking instead of queueing behind it. */
  interrupt?: boolean;
}

export interface SpeakResult {
  spoken: string;
  voice: string | null;
  durationMs: number;
  /** The utterance was cut off by `stop()` or by a later `interrupt`. */
  interrupted: boolean;
  /** The wait cap elapsed first; the utterance is still being spoken. */
  stillSpeaking: boolean;
}

/**
 * What the header voice control renders. `blocked` is the browser refusing to
 * speak without user activation — the whole reason that control exists.
 */
export interface SpeechState {
  supported: boolean;
  armed: boolean;
  speaking: boolean;
  blocked: boolean;
  lastError: string | null;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ModelContextLike {
  registerTool: (
    tool: ToolDefinition,
    options?: { signal?: AbortSignal },
  ) => Promise<void> | void;
}

declare global {
  interface Document {
    modelContext?: ModelContextLike;
  }
}

