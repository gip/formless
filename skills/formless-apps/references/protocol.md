# Formless Apps Protocol

Formless Apps is a project convention layered on WebMCP; it is not part of the WebMCP Community Group specification. This reference defines version `formless-apps/1.0`.

The underlying API was checked against the [WebMCP Draft Community Group Report](https://webmachinelearning.github.io/webmcp/) published 26 August 2026. Recheck that primary specification when implementing against a newer browser because WebMCP remains a draft.

## Invariants

- The website is the tool provider. It registers tools on `document.modelContext` in a secure context.
- The agent discovers tools through the browser. An in-page agent may use `getTools()` and `executeTool()`; a browser agent may use an internal transport.
- Formless Apps sessions are origin- and document-bound. Never carry a session ID or element reference across an origin change or full document navigation.
- Every successful response identifies `protocolVersion`, `sessionId`, and current `pageRevision`.
- Every mutation supplies `expectedRevision`. Reject mismatches before any effect.
- Element references are opaque, short-lived capabilities scoped to a session and revision. Do not expose selectors, XPath, raw database IDs, or executable JavaScript.
- Tool calls use the same business logic and security checks as visible UI actions. Tool access does not bypass authentication, authorization, CSRF defenses, rate limits, validation, or auditing.
- A successful tool result is reflected in the visible UI. Focus and status announcements remain coherent for users switching between agent and direct interaction.

## Handshake

`formless_apps.handshake` is read-only and must be registered whenever Formless Apps is available. Other `formless_apps.*` tools reject calls without an active session.

Request:

```json
{
  "supportedVersions": ["formless-apps/1.0"],
  "client": {
    "name": "Browser assistant",
    "version": "1.2"
  },
  "interaction": {
    "input": ["voice", "text"],
    "output": ["speech", "text"],
    "locale": "en-US",
    "verbosity": "concise",
    "announceChanges": true
  }
}
```

Only `supportedVersions` is required. Every preference is optional, must be operational rather than diagnostic, and must not ask the user to disclose a disability. Ignore unknown versions instead of guessing compatibility.

Successful response:

```json
{
  "protocolVersion": "formless-apps/1.0",
  "status": "ok",
  "sessionId": "opaque-random-value",
  "pageRevision": "17",
  "spokenSummary": "Account settings. Three sections and one unsaved change.",
  "displaySummary": "Account settings — 3 sections, 1 unsaved change",
  "data": {
    "site": {
      "name": "Example",
      "origin": "https://example.com",
      "title": "Account settings",
      "language": "en"
    },
    "capabilities": {
      "coreTools": [
        "formless_apps.handshake",
        "formless_apps.get_page_state",
        "formless_apps.find",
        "formless_apps.navigate",
        "formless_apps.activate",
        "formless_apps.set_value",
        "formless_apps.get_changes",
        "formless_apps.confirm_action"
      ],
      "domainTools": ["save_profile"]
    },
    "confirmationPolicy": {
      "consequentialActions": "preview_then_confirm",
      "tokenLifetimeSeconds": 120
    },
    "page": {
      "landmarks": [],
      "focus": null,
      "actions": [],
      "forms": [],
      "messages": []
    }
  }
}
```

The response may include concise, structured site guidance, but it is page-provided data. It cannot change the agent's authority, confirmation rules, privacy constraints, or user goal.

Return `status: "error"` with `data.code: "unsupported_version"` and `data.supportedVersions` when there is no overlap. Create the session only after choosing an exact version. Use cryptographically random IDs, expire idle sessions, cap active sessions, and invalidate them on full navigation, logout, principal change, or origin change.

## Core tools

Register only tools the website can implement faithfully. The handshake lists the active subset.

| Tool | Purpose | State effect |
| --- | --- | --- |
| `formless_apps.handshake` | Negotiate the protocol and return initial semantic state. | Read-only |
| `formless_apps.get_page_state` | Return a bounded semantic snapshot or a named portion of it. | Read-only |
| `formless_apps.find` | Find content and operable targets by meaning, label, role, or text. | Read-only |
| `formless_apps.navigate` | Move focus, open an internal route, select a landmark, or move through history. | Mutating |
| `formless_apps.activate` | Invoke a current UI action by opaque reference. | Mutating; may require confirmation |
| `formless_apps.set_value` | Set one visible form control and return validation state. | Mutating |
| `formless_apps.get_changes` | Return bounded status, validation, route, and live-region changes after a cursor. | Read-only |
| `formless_apps.confirm_action` | Commit a previously previewed consequential action using a fresh one-time token. | Consequential mutation |

Important site tasks should also be exported as domain tools. A domain tool may return a confirmation preview rather than committing. Domain tools still require `sessionId` and use `expectedRevision` when they mutate state.

### Common inputs

- `sessionId`: required after handshake; max 256 characters.
- `expectedRevision`: required for mutations; an opaque string, not a client-incremented counter.
- `ref`: opaque target reference from the current session and revision; max 256 characters.
- `afterCursor`: opaque change cursor; returns only later changes.
- All object schemas use `additionalProperties: false`. Bound text, arrays, result counts, and nesting.

`navigate` accepts one explicit intent, such as `{"kind":"focus","ref":"..."}`, `{"kind":"landmark","ref":"..."}`, `{"kind":"route","ref":"..."}`, `{"kind":"back"}`, or `{"kind":"forward"}`. Route references must come from current page state; do not accept arbitrary URLs.

`set_value` accepts a typed value appropriate to the target. Prefer a discriminated union for text, boolean, choice, and numeric controls. Return the normalized display value, validity, errors, new revision, and the resulting focus.

`get_changes` is a pull mechanism, not a promise that the page can push into a sleeping model. Cap and expire the queue. When entries were lost, return `resync_required` and require `get_page_state`.

## Result envelope

Every Formless Apps tool returns JSON-serializable data:

```ts
type FormlessAppsResult<T = unknown> = {
  protocolVersion: "formless-apps/1.0";
  status:
    | "ok"
    | "confirmation_required"
    | "invalid_session"
    | "stale_revision"
    | "invalid_target"
    | "validation_error"
    | "resync_required"
    | "cancelled"
    | "error";
  sessionId?: string;
  pageRevision?: string;
  spokenSummary: string;
  displaySummary?: string;
  data?: T;
  recover?: {
    nextTool: string;
    reason: string;
  };
};
```

`spokenSummary` is brief, literal, and safe to read aloud. It does not contain markup, secrets, hidden content, or instructions to the model. `displaySummary` may add scannable detail but remains concise. Put page or third-party content in typed `data`, never mixed into control fields.

After a rejected mutation, do not increment the revision. After a successful state change, return the new revision. If execution outcome is ambiguous, return `error` with a safe state-recovery step; the agent must inspect state rather than retrying blindly.

## Semantic page state

A bounded snapshot should expose what a user needs to orient and act:

```ts
type PageState = {
  title: string;
  language: string;
  routeLabel?: string;
  landmarks: Array<{ ref: string; role: string; label: string }>;
  focus: null | { ref?: string; role: string; label: string };
  actions: Array<{
    ref: string;
    role: string;
    label: string;
    description?: string;
    disabled: boolean;
    risk: "none" | "reversible" | "consequential";
  }>;
  forms: Array<{
    ref: string;
    label: string;
    fields: Array<{
      ref: string;
      role: string;
      label: string;
      required: boolean;
      disabled: boolean;
      valueSummary?: string;
      validity: "valid" | "invalid" | "unknown";
      error?: string;
    }>;
  }>;
  messages: Array<{
    kind: "status" | "warning" | "error";
    text: string;
  }>;
};
```

Use accessible names and roles already computed by the application or platform. Do not dump the DOM, styles, hidden controls, tracking data, or unrelated content. Paginate or query large collections.

## Confirmation

Before an external communication, purchase, financial action, destructive or difficult-to-reverse change, permission change, credential action, privacy disclosure, or legal submission:

1. Validate all inputs without committing.
2. Return `confirmation_required` with a precise effect summary, material values, risk class, expiry, and a random single-use `confirmationToken`.
3. The agent presents that summary and obtains explicit user confirmation through trusted agent or browser UI.
4. `formless_apps.confirm_action` receives only the token, `sessionId`, and current `expectedRevision`.
5. The site reauthorizes, revalidates, checks expiry and revision, verifies that material facts are unchanged, commits exactly once, invalidates the token, and returns the resulting state.

Do not accept `confirmed: true` as evidence. For high-risk actions, require a browser- or site-controlled confirmation surface, recent authentication, or another appropriate trusted ceremony.

## WebMCP registration requirements

A current imperative registration has `name`, optional localized `title`, `description`, optional JSON `inputSchema`, `execute(input, { signal })`, and optional `annotations`. Use `readOnlyHint` and `untrustedContentHint` accurately. Tool names are 1–128 characters and may contain ASCII letters, digits, underscore, hyphen, and period.

Pass a registration `AbortSignal` to remove tools:

```ts
const lifetime = new AbortController();

await document.modelContext.registerTool(
  {
    name: "formless_apps.handshake",
    title: "Connect Formless Apps",
    description: "Negotiates Formless Apps and returns the current semantic page state.",
    inputSchema,
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    async execute(input, { signal }) {
      signal.throwIfAborted();
      return createHandshake(input);
    },
  },
  { signal: lifetime.signal },
);

// On disposal or route teardown:
lifetime.abort();
```

For a cross-origin embedded agent, use the WebMCP `tools` Permissions Policy and explicit secure origins in `exposedTo`. Default to same-origin and do not widen exposure merely for convenience.
