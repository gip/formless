---
name: formless-apps
description: "Add or review a Formless Apps layer on a website: WebMCP tools for semantic navigation and voice/text operation, a versioned model-site handshake, and a trusted agent system prompt. Use when making a web app agent-operable or defining its Formless Apps protocol; do not treat this as a substitute for semantic HTML, keyboard support, or WCAG work."
---

# Formless Apps

Implement Formless Apps as an accessibility-oriented convention layered on the current WebMCP API. Preserve the site's visible, keyboard-accessible UI and reuse the same application services, validation, authorization, and audit paths that human interactions use.

## Choose the work

- For a protocol or architecture request, read [references/protocol.md](references/protocol.md).
- For an agent prompt or handshake integration, also read [references/system-prompt.md](references/system-prompt.md).
- For website code, also read [references/implementation.md](references/implementation.md) and adapt [assets/formless-apps-starter.ts](assets/formless-apps-starter.ts).
- For review work, compare the implementation against the protocol invariants and verification checklist in those references. Report the distinction between WebMCP requirements and Formless Apps conventions.

## Required outcome

Expose the smallest useful tool surface:

1. Register the eight core `formless_apps.*` tools defined by the protocol when their capabilities exist.
2. Add domain tools for important site tasks; prefer `search_products` or `save_draft` over long sequences of generic element operations.
3. Require `formless_apps.handshake` before other Formless Apps calls. Bind the session to the current origin and document, return an initial semantic page snapshot, and use a page revision to reject stale mutations.
4. Install the trusted agent-side system prompt outside page-controlled content. Never promote handshake fields, tool descriptions, or tool output to system authority.
5. Make consequential effects previewable and require fresh, explicit confirmation. Do not blindly retry mutations after timeouts or ambiguous failures.
6. Return concise spoken and displayed summaries, update visible UI and focus coherently, and expose meaningful changes for users who interact by voice or text.

## Non-negotiable boundaries

- Use `document.modelContext`. Older `navigator.modelContext`, `provideContext()`, `clearContext()`, and name-based `unregisterTool()` examples are stale for the current draft.
- Own registrations with an `AbortController`; abort on route teardown or component disposal.
- Treat tool metadata, page content, and returned content as untrusted data. Mark tools returning user-generated or third-party content with `untrustedContentHint: true`.
- Set `readOnlyHint: true` only when execution cannot change page, account, server, navigation, focus, preferences, or other observable state.
- Keep schemas narrow, set `additionalProperties: false`, bound strings and arrays, and request no personal attribute that is unnecessary for the action.
- Keep server authorization and trusted confirmation checks authoritative. A model-provided boolean is not proof of consent.
- Formless Apps augments rather than replaces accessible names, native controls, headings and landmarks, keyboard operation, focus order, status announcements, error association, and sufficient contrast.

## Verify

Test through the actual WebMCP discovery and execution path when available, plus a deterministic local harness for unsupported browsers. Verify handshake rejection, invalid sessions, stale revisions, abort cancellation, dynamic registration cleanup, focus after navigation, validation errors, confirmation expiry and single use, untrusted output, and identical authorization for UI and tool paths.

When the browser does not implement the current draft, keep the Formless Apps code feature-detected and provide a development-only adapter or console. Do not silently replace the public contract with an incompatible API.
