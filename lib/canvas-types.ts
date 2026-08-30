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

