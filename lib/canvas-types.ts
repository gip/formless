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

