/*
 * Formless Apps starter, protocol formless-apps/1.0.
 *
 * Copy this file into the website and implement FormlessAppsAdapter with the
 * application's semantic state and existing action services.
 */

export const FORMLESS_APPS_VERSION = "formless-apps/1.0" as const;

export type FormlessAppsStatus =
  | "ok"
  | "confirmation_required"
  | "invalid_session"
  | "stale_revision"
  | "invalid_target"
  | "validation_error"
  | "resync_required"
  | "cancelled"
  | "error";

export interface FormlessAppsResult<T = unknown> {
  protocolVersion: typeof FORMLESS_APPS_VERSION;
  status: FormlessAppsStatus;
  sessionId?: string;
  pageRevision?: string;
  spokenSummary: string;
  displaySummary?: string;
  data?: T;
  recover?: {
    nextTool: string;
    reason: string;
  };
}

export interface FormlessAppsSite {
  name: string;
  title: string;
  language: string;
}

export interface FormlessAppsInteraction {
  input?: Array<"voice" | "text" | "keyboard" | "switch">;
  output?: Array<"speech" | "text" | "braille">;
  locale?: string;
  verbosity?: "concise" | "standard" | "detailed";
  announceChanges?: boolean;
}

export interface AdapterOutcome<T = unknown> {
  status?: Exclude<FormlessAppsStatus, "invalid_session" | "stale_revision">;
  spokenSummary: string;
  displaySummary?: string;
  data?: T;
  recover?: FormlessAppsResult["recover"];
}

export interface FormlessAppsAdapter {
  getSite(): FormlessAppsSite;
  getRevision(): string;
  getPrincipalKey(): string | null;

  getPageState(
    input: { scope?: "page" | "landmarks" | "actions" | "forms" | "messages" },
    signal: AbortSignal,
  ): Promise<unknown>;

  find(
    input: {
      query: string;
      kinds?: Array<"content" | "landmark" | "action" | "field">;
      limit: number;
    },
    signal: AbortSignal,
  ): Promise<unknown>;

  navigate(
    input: {
      kind: "focus" | "landmark" | "route" | "back" | "forward";
      ref?: string;
    },
    signal: AbortSignal,
  ): Promise<AdapterOutcome>;

  activate(
    input: { ref: string },
    signal: AbortSignal,
  ): Promise<AdapterOutcome>;

  setValue(
    input: { ref: string; value: string | number | boolean | null },
    signal: AbortSignal,
  ): Promise<AdapterOutcome>;

  getChanges(
    input: { afterCursor?: string; limit: number },
    signal: AbortSignal,
  ): Promise<unknown>;

  confirmAction(
    input: { confirmationToken: string },
    signal: AbortSignal,
  ): Promise<AdapterOutcome>;
}

type JsonObject = Record<string, unknown>;

interface ToolExecutionOptions {
  signal: AbortSignal;
}

export interface WebMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  execute(
    input: JsonObject,
    options: ToolExecutionOptions,
  ): Promise<FormlessAppsResult>;
}

interface ModelContextLike {
  registerTool(
    tool: WebMcpTool,
    options?: { signal?: AbortSignal; exposedTo?: string[] },
  ): Promise<void>;
}

interface Session {
  id: string;
  origin: string;
  principalKey: string | null;
  interaction?: FormlessAppsInteraction;
  lastUsedAt: number;
}

export interface InstallFormlessAppsOptions {
  domainTools?: string[];
  exposedTo?: string[];
  sessionIdleMs?: number;
  maximumSessions?: number;
  confirmationTokenLifetimeSeconds?: number;
}

export interface FormlessAppsInstallation {
  supported: boolean;
  tools: readonly WebMcpTool[];
  dispose(): void;
}

class ProtocolFault extends Error {
  constructor(
    readonly status: FormlessAppsStatus,
    message: string,
    readonly nextTool?: string,
  ) {
    super(message);
  }
}

const objectSchema = (
  properties: JsonObject,
  required: string[],
): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const sessionProperty = {
  type: "string",
  minLength: 1,
  maxLength: 256,
};

const revisionProperty = {
  type: "string",
  minLength: 1,
  maxLength: 128,
};

const refProperty = {
  type: "string",
  minLength: 1,
  maxLength: 256,
};

const schemas = {
  handshake: objectSchema(
    {
      supportedVersions: {
        type: "array",
        items: { type: "string", maxLength: 64 },
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
      },
      client: objectSchema(
        {
          name: { type: "string", maxLength: 100 },
          version: { type: "string", maxLength: 50 },
        },
        ["name"],
      ),
      interaction: objectSchema(
        {
          input: {
            type: "array",
            items: {
              enum: ["voice", "text", "keyboard", "switch"],
            },
            maxItems: 4,
            uniqueItems: true,
          },
          output: {
            type: "array",
            items: { enum: ["speech", "text", "braille"] },
            maxItems: 3,
            uniqueItems: true,
          },
          locale: { type: "string", maxLength: 35 },
          verbosity: {
            enum: ["concise", "standard", "detailed"],
          },
          announceChanges: { type: "boolean" },
        },
        [],
      ),
    },
    ["supportedVersions"],
  ),
  getPageState: objectSchema(
    {
      sessionId: sessionProperty,
      scope: {
        enum: ["page", "landmarks", "actions", "forms", "messages"],
      },
    },
    ["sessionId"],
  ),
  find: objectSchema(
    {
      sessionId: sessionProperty,
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
      },
      kinds: {
        type: "array",
        items: {
          enum: ["content", "landmark", "action", "field"],
        },
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
      },
    },
    ["sessionId", "query"],
  ),
  navigate: objectSchema(
    {
      sessionId: sessionProperty,
      expectedRevision: revisionProperty,
      kind: {
        enum: ["focus", "landmark", "route", "back", "forward"],
      },
      ref: refProperty,
    },
    ["sessionId", "expectedRevision", "kind"],
  ),
  activate: objectSchema(
    {
      sessionId: sessionProperty,
      expectedRevision: revisionProperty,
      ref: refProperty,
    },
    ["sessionId", "expectedRevision", "ref"],
  ),
  setValue: objectSchema(
    {
      sessionId: sessionProperty,
      expectedRevision: revisionProperty,
      ref: refProperty,
      value: {
        type: ["string", "number", "boolean", "null"],
      },
    },
    ["sessionId", "expectedRevision", "ref", "value"],
  ),
  getChanges: objectSchema(
    {
      sessionId: sessionProperty,
      afterCursor: {
        type: "string",
        maxLength: 256,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
      },
    },
    ["sessionId"],
  ),
  confirmAction: objectSchema(
    {
      sessionId: sessionProperty,
      expectedRevision: revisionProperty,
      confirmationToken: {
        type: "string",
        minLength: 16,
        maxLength: 512,
      },
    },
    ["sessionId", "expectedRevision", "confirmationToken"],
  ),
} as const;

export async function installFormlessApps(
  adapter: FormlessAppsAdapter,
  options: InstallFormlessAppsOptions = {},
): Promise<FormlessAppsInstallation> {
  if (typeof document === "undefined") {
    throw new Error("Formless Apps must be installed in an active browser document.");
  }

  const lifetime = new AbortController();
  const sessions = new Map<string, Session>();
  const origin = globalThis.location?.origin ?? "";
  const idleMs = options.sessionIdleMs ?? 15 * 60 * 1000;
  const maximumSessions = Math.max(1, options.maximumSessions ?? 8);

  const result = <T>(
    status: FormlessAppsStatus,
    spokenSummary: string,
    session?: Session,
    details: {
      displaySummary?: string;
      data?: T;
      recover?: FormlessAppsResult["recover"];
    } = {},
  ): FormlessAppsResult<T> => ({
    protocolVersion: FORMLESS_APPS_VERSION,
    status,
    ...(session
      ? {
          sessionId: session.id,
          pageRevision: adapter.getRevision(),
        }
      : {}),
    spokenSummary,
    ...details,
  });

  const requireSession = (input: JsonObject): Session => {
    const id = readString(input, "sessionId", 256);
    const session = sessions.get(id);
    const now = Date.now();

    if (
      !session ||
      session.origin !== origin ||
      now - session.lastUsedAt > idleMs ||
      session.principalKey !== adapter.getPrincipalKey()
    ) {
      if (session) sessions.delete(id);
      throw new ProtocolFault(
        "invalid_session",
        "This Formless Apps session is no longer valid.",
        "formless_apps.handshake",
      );
    }

    session.lastUsedAt = now;
    return session;
  };

  const requireCurrentRevision = (input: JsonObject): void => {
    const expected = readString(input, "expectedRevision", 128);
    if (expected !== adapter.getRevision()) {
      throw new ProtocolFault(
        "stale_revision",
        "The page changed before that action could run.",
        "formless_apps.get_page_state",
      );
    }
  };

  const wrap = (
    implementation: (
      input: JsonObject,
      signal: AbortSignal,
    ) => Promise<FormlessAppsResult>,
  ): WebMcpTool["execute"] =>
    async (input, executionOptions) => {
      try {
        executionOptions.signal.throwIfAborted();
        return await implementation(input, executionOptions.signal);
      } catch (error) {
        const session = findSession(input, sessions);
        if (executionOptions.signal.aborted || isAbortError(error)) {
          return result(
            "cancelled",
            "The action was cancelled.",
            session,
          );
        }
        if (error instanceof ProtocolFault) {
          return result(error.status, error.message, session, {
            recover: error.nextTool
              ? { nextTool: error.nextTool, reason: error.message }
              : undefined,
          });
        }
        return result(
          "error",
          "The website could not complete that action.",
          session,
          {
            recover: {
              nextTool: "formless_apps.get_page_state",
              reason:
                "Inspect the current state before deciding whether to try another action.",
            },
          },
        );
      }
    };

  const runRead = (
    input: JsonObject,
    signal: AbortSignal,
    operation: () => Promise<unknown>,
    spokenSummary: string,
  ): Promise<FormlessAppsResult> => {
    const session = requireSession(input);
    return operation().then((data) => {
      signal.throwIfAborted();
      return result("ok", spokenSummary, session, { data });
    });
  };

  const runMutation = async (
    input: JsonObject,
    signal: AbortSignal,
    operation: () => Promise<AdapterOutcome>,
  ): Promise<FormlessAppsResult> => {
    const session = requireSession(input);
    requireCurrentRevision(input);
    const outcome = await operation();
    signal.throwIfAborted();
    return result(
      outcome.status ?? "ok",
      outcome.spokenSummary,
      session,
      {
        displaySummary: outcome.displaySummary,
        data: outcome.data,
        recover: outcome.recover,
      },
    );
  };

  const tools: WebMcpTool[] = [
    {
      name: "formless_apps.handshake",
      title: "Connect Formless Apps",
      description:
        "Negotiates Formless Apps and returns a bounded semantic snapshot of the current page. Call this before other formless_apps tools.",
      inputSchema: schemas.handshake,
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: wrap(async (input, signal) => {
        const versions = readStringArray(
          input,
          "supportedVersions",
          8,
          64,
        );
        if (!versions.includes(FORMLESS_APPS_VERSION)) {
          return result(
            "error",
            "This website and assistant do not share a Formless Apps version.",
            undefined,
            {
              data: {
                code: "unsupported_version",
                supportedVersions: [FORMLESS_APPS_VERSION],
              },
            },
          );
        }

        const interaction = readInteraction(input.interaction);
        pruneSessions(
          sessions,
          Date.now(),
          idleMs,
          maximumSessions - 1,
        );
        const session: Session = {
          id: randomId(),
          origin,
          principalKey: adapter.getPrincipalKey(),
          interaction,
          lastUsedAt: Date.now(),
        };
        sessions.set(session.id, session);

        const page = await adapter.getPageState(
          { scope: "page" },
          signal,
        );
        signal.throwIfAborted();
        const site = adapter.getSite();
        return result(
          "ok",
          "Formless Apps is ready for voice or text navigation.",
          session,
          {
            displaySummary: site.title,
            data: {
              site: {
                ...site,
                origin,
              },
              capabilities: {
                coreTools: tools.map((tool) => tool.name),
                domainTools: options.domainTools ?? [],
              },
              confirmationPolicy: {
                consequentialActions: "preview_then_confirm",
                tokenLifetimeSeconds:
                  options.confirmationTokenLifetimeSeconds ?? 120,
              },
              interaction,
              page,
            },
          },
        );
      }),
    },
    {
      name: "formless_apps.get_page_state",
      title: "Describe page",
      description:
        "Returns a bounded semantic snapshot of the current page or one requested section. It does not change the page.",
      inputSchema: schemas.getPageState,
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: wrap((input, signal) =>
        runRead(
          input,
          signal,
          () =>
            adapter.getPageState(
              {
                scope: readOptionalEnum(input, "scope", [
                  "page",
                  "landmarks",
                  "actions",
                  "forms",
                  "messages",
                ]),
              },
              signal,
            ),
          "Here is the current page state.",
        ),
      ),
    },
    {
      name: "formless_apps.find",
      title: "Find on page",
      description:
        "Finds current content and controls by meaning, accessible label, role, or text. It does not change the page.",
      inputSchema: schemas.find,
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: wrap((input, signal) =>
        runRead(
          input,
          signal,
          () =>
            adapter.find(
              {
                query: readString(input, "query", 500),
                kinds: readOptionalEnumArray(input, "kinds", [
                  "content",
                  "landmark",
                  "action",
                  "field",
                ]),
                limit: readOptionalInteger(input, "limit", 1, 50) ?? 10,
              },
              signal,
            ),
          "Here are the matching page items.",
        ),
      ),
    },
    {
      name: "formless_apps.navigate",
      title: "Navigate page",
      description:
        "Moves focus, selects a current landmark or internal route, or moves through page history. It does not accept arbitrary URLs.",
      inputSchema: schemas.navigate,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
      },
      execute: wrap((input, signal) =>
        runMutation(input, signal, () => {
          const kind = readEnum(input, "kind", [
            "focus",
            "landmark",
            "route",
            "back",
            "forward",
          ]);
          const ref = readOptionalString(input, "ref", 256);
          const needsRef =
            kind === "focus" ||
            kind === "landmark" ||
            kind === "route";
          if ((needsRef && !ref) || (!needsRef && ref)) {
            throw new ProtocolFault(
              "validation_error",
              needsRef
                ? "That navigation kind requires a current target reference."
                : "History navigation does not accept a target reference.",
            );
          }
          return adapter.navigate({ kind, ref }, signal);
        }),
      ),
    },
    {
      name: "formless_apps.activate",
      title: "Activate control",
      description:
        "Activates one current UI control by opaque reference. Consequential effects return a preview instead of committing.",
      inputSchema: schemas.activate,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
      },
      execute: wrap((input, signal) =>
        runMutation(input, signal, () =>
          adapter.activate(
            { ref: readString(input, "ref", 256) },
            signal,
          ),
        ),
      ),
    },
    {
      name: "formless_apps.set_value",
      title: "Set field value",
      description:
        "Sets one current visible form control and returns its normalized value and validation state. It does not submit the form.",
      inputSchema: schemas.setValue,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
      },
      execute: wrap((input, signal) =>
        runMutation(input, signal, () =>
          adapter.setValue(
            {
              ref: readString(input, "ref", 256),
              value: readScalar(input, "value"),
            },
            signal,
          ),
        ),
      ),
    },
    {
      name: "formless_apps.get_changes",
      title: "Get page changes",
      description:
        "Returns bounded status, validation, route, focus, and live-region changes after an optional cursor. It does not change the page.",
      inputSchema: schemas.getChanges,
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: wrap((input, signal) =>
        runRead(
          input,
          signal,
          () =>
            adapter.getChanges(
              {
                afterCursor: readOptionalString(
                  input,
                  "afterCursor",
                  256,
                ),
                limit: readOptionalInteger(input, "limit", 1, 50) ?? 20,
              },
              signal,
            ),
          "Here are the latest page changes.",
        ),
      ),
    },
    {
      name: "formless_apps.confirm_action",
      title: "Confirm action",
      description:
        "Commits one previously previewed consequential action using its fresh, single-use confirmation token.",
      inputSchema: schemas.confirmAction,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
      },
      execute: wrap((input, signal) =>
        runMutation(input, signal, () =>
          adapter.confirmAction(
            {
              confirmationToken: readString(
                input,
                "confirmationToken",
                512,
              ),
            },
            signal,
          ),
        ),
      ),
    },
  ];

  const modelContext = (
    document as Document & { modelContext?: ModelContextLike }
  ).modelContext;

  if (!modelContext?.registerTool) {
    return {
      supported: false,
      tools,
      dispose() {
        lifetime.abort();
        sessions.clear();
      },
    };
  }

  try {
    await Promise.all(
      tools.map((tool) =>
        modelContext.registerTool(tool, {
          signal: lifetime.signal,
          ...(options.exposedTo
            ? { exposedTo: [...options.exposedTo] }
            : {}),
        }),
      ),
    );
  } catch (error) {
    lifetime.abort();
    sessions.clear();
    throw error;
  }

  return {
    supported: true,
    tools,
    dispose() {
      lifetime.abort();
      sessions.clear();
    },
  };
}

function readString(
  input: JsonObject,
  key: string,
  maxLength: number,
): string {
  const value = input[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new ProtocolFault(
      "validation_error",
      "The " + key + " value is missing or invalid.",
    );
  }
  return value;
}

function readOptionalString(
  input: JsonObject,
  key: string,
  maxLength: number,
): string | undefined {
  if (input[key] === undefined) return undefined;
  return readString(input, key, maxLength);
}

function readStringArray(
  input: JsonObject,
  key: string,
  maxItems: number,
  maxLength: number,
): string[] {
  const value = input[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maxItems ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > maxLength,
    )
  ) {
    throw new ProtocolFault(
      "validation_error",
      "The " + key + " list is missing or invalid.",
    );
  }
  return value as string[];
}

function readEnum<const T extends readonly string[]>(
  input: JsonObject,
  key: string,
  allowed: T,
): T[number] {
  const value = readString(input, key, 128);
  if (!allowed.includes(value)) {
    throw new ProtocolFault(
      "validation_error",
      "The " + key + " value is not supported.",
    );
  }
  return value as T[number];
}

function readOptionalEnum<const T extends readonly string[]>(
  input: JsonObject,
  key: string,
  allowed: T,
): T[number] | undefined {
  if (input[key] === undefined) return undefined;
  return readEnum(input, key, allowed);
}

function readOptionalEnumArray<const T extends readonly string[]>(
  input: JsonObject,
  key: string,
  allowed: T,
): T[number][] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > allowed.length ||
    value.some(
      (entry) =>
        typeof entry !== "string" || !allowed.includes(entry),
    )
  ) {
    throw new ProtocolFault(
      "validation_error",
      "The " + key + " list is invalid.",
    );
  }
  return value as T[number][];
}

function readOptionalInteger(
  input: JsonObject,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ProtocolFault(
      "validation_error",
      "The " + key + " value is invalid.",
    );
  }
  return value;
}

function readScalar(
  input: JsonObject,
  key: string,
): string | number | boolean | null {
  const value = input[key];
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new ProtocolFault(
      "validation_error",
      "The " + key + " value is invalid.",
    );
  }
  if (typeof value === "string" && value.length > 10000) {
    throw new ProtocolFault(
      "validation_error",
      "The " + key + " value is too long.",
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ProtocolFault(
      "validation_error",
      "The " + key + " number must be finite.",
    );
  }
  return value as string | number | boolean | null;
}

function readInteraction(value: unknown): FormlessAppsInteraction | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolFault(
      "validation_error",
      "The interaction preferences are invalid.",
    );
  }
  const input = value as JsonObject;
  return {
    input: readOptionalEnumArray(input, "input", [
      "voice",
      "text",
      "keyboard",
      "switch",
    ]),
    output: readOptionalEnumArray(input, "output", [
      "speech",
      "text",
      "braille",
    ]),
    locale: readOptionalString(input, "locale", 35),
    verbosity: readOptionalEnum(input, "verbosity", [
      "concise",
      "standard",
      "detailed",
    ]),
    announceChanges:
      typeof input.announceChanges === "boolean"
        ? input.announceChanges
        : undefined,
  };
}

function findSession(
  input: JsonObject,
  sessions: Map<string, Session>,
): Session | undefined {
  return typeof input.sessionId === "string"
    ? sessions.get(input.sessionId)
    : undefined;
}

function pruneSessions(
  sessions: Map<string, Session>,
  now: number,
  idleMs: number,
  maximumToKeep: number,
): void {
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > idleMs) sessions.delete(id);
  }
  const oldestFirst = [...sessions.values()].sort(
    (a, b) => a.lastUsedAt - b.lastUsedAt,
  );
  while (oldestFirst.length > Math.max(0, maximumToKeep)) {
    const oldest = oldestFirst.shift();
    if (oldest) sessions.delete(oldest.id);
  }
}

function randomId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}
