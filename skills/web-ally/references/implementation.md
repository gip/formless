# Website Implementation Guide

Use this guide after reading [protocol.md](protocol.md). The framework-neutral starter is [../assets/web-ally-starter.ts](../assets/web-ally-starter.ts).

## 1. Preserve the accessible UI

Start with native elements and semantic HTML. Give controls accessible names, group and label form fields, use headings and landmarks, preserve keyboard order, associate validation errors, manage focus after route and dialog changes, and announce asynchronous status through appropriate live regions. Web Ally should call the same handlers a keyboard or pointer user reaches.

Do not construct page state by scraping visual coordinates. Build it from the application's semantic view model or a protected registry tied to rendered accessible components. If using a registry, audit that every important operable control is represented and that duplicate IDs fail tests.

## 2. Add the session and revision layer

Create one Web Ally service per active document:

- Generate a cryptographically random session ID during handshake.
- Record the chosen version, origin, document identity, authenticated principal fingerprint, preferences, last-used time, and current revision.
- Expire sessions and confirmation tokens; cap memory; invalidate on teardown.
- Increment the revision after every observable state mutation, including route, focus, form value, preference, and server-backed state changes.
- Verify `sessionId`, origin, principal, and `expectedRevision` inside the tool implementation, not only in the model prompt.

If the application already has revisions or ETags, reuse them. Otherwise maintain a document-scoped monotonic counter encoded as an opaque string. Serialize mutations so two calls cannot both pass the same revision check.

## 3. Adapt the starter

Copy `assets/web-ally-starter.ts` into the application and implement its `WebAllyAdapter`. The adapter intentionally owns application-specific behavior:

- `getPageState` returns a bounded semantic snapshot.
- `find` searches the semantic registry.
- `navigate`, `activate`, and `setValue` call real UI/application services and return resulting state.
- `getChanges` reads an in-memory, bounded event queue.
- `confirmAction` consumes a server- or site-issued token after reauthorization.

The starter provides registration lifecycle, feature detection, version negotiation, session checks, revision checks, common schemas, cancellation propagation, and safe result envelopes. Replace its in-memory session store if the website needs stronger persistence or multi-frame coordination.

Register domain tools separately with the same guards. Give each tool a literal description of all important side effects. Prefer previews for consequential tools:

```ts
await registerDomainTool({
  name: "send_message",
  title: "Send message",
  description:
    "Previews a message to one recipient. It does not send until the returned confirmation token is confirmed.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", maxLength: 256 },
      expectedRevision: { type: "string", maxLength: 128 },
      recipientRef: { type: "string", maxLength: 256 },
      body: { type: "string", minLength: 1, maxLength: 10000 }
    },
    required: ["sessionId", "expectedRevision", "recipientRef", "body"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, untrustedContentHint: false },
  execute: previewMessage
});
```

## 4. Register at the correct lifecycle

`document.modelContext.registerTool()` is asynchronous. Await registrations, handle `NotAllowedError`, and report initialization failures in development. Pass one registration `AbortSignal` to all page-scoped tools and abort it before registering replacements.

For a single-page app, either keep stable core tools and let the adapter reflect current state, or abort and re-register route-specific domain tools. Do not register duplicate names. Dynamic registration may emit `toolchange`; do not rely on its timing relative to unrelated task queues.

Use same-origin exposure by default. A cross-origin in-page agent requires both `allow="tools"` or an equivalent Permissions Policy and an exact secure origin in `exposedTo`.

## 5. Return usable results

Update visible state before resolving a successful mutation. Return:

- a short `spokenSummary`;
- a scannable `displaySummary` when useful;
- the new revision;
- resulting focus and validation state;
- a recovery instruction for stale, invalid, or truncated state.

Do not return a raw DOM subtree, HTML, stack trace, bearer token, cookies, or hidden state. Mark any tool whose result contains user-generated or third-party text with `untrustedContentHint: true`; keep such text in a structured data field.

## 6. Browser compatibility

Feature-detect `document.modelContext?.registerTool`. The current standard surface is `document.modelContext`; do not ship old examples using `provideContext()`, `clearContext()`, or name-based `unregisterTool()`.

For development in a browser without WebMCP, make the same tool definitions available to a local inspector or test harness. The fallback should invoke the exact same execute callbacks and schemas. It must not become a hidden production command channel.

## Verification matrix

| Area | Checks |
| --- | --- |
| Discovery | Exactly one active registration per name; titles localized; descriptions disclose effects; schemas reject extras and oversize values. |
| Handshake | Chooses only a shared version; no session on mismatch; random session; origin/document/principal binding; initial state bounded. |
| State | Accessible names and roles are accurate; references expire; stale mutation has no effect; revisions increment after observable changes. |
| Voice/text | Spoken summaries are concise; lists paginate; one question at a time; errors identify the field; no color/coordinate-only references. |
| Focus | Route, dialog, validation, and activation outcomes put focus predictably and expose the new focus in results. |
| Security | Same UI authorization path; no unnecessary personal parameters; untrusted output annotated; cross-origin exposure denied by default. |
| Confirmation | Exact preview; token random, short-lived, revision-bound, principal-bound, single-use; material change forces a new preview. |
| Failure | Abort stops work; timeout is not reported as success; ambiguous mutation is inspected before retry; queue overflow requests resync. |
| Lifecycle | Teardown aborts registrations and pending work; logout invalidates sessions/tokens; no stale tools after route changes. |
| Accessibility | Keyboard-only and assistive-technology use still works with WebMCP disabled. |

Automate contract tests around the tool definitions and adapter. Add end-to-end tests that discover and execute tools through the browser path when supported. Include a mocked local harness for deterministic CI, but keep at least one native integration check before release.
