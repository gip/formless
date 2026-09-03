# AGENTS.md

This file provides repository-specific guidance to coding agents. Keep it focused on non-obvious architecture, invariants, and verification requirements; use `README.md` for user-facing setup.

## Commands

Package manager is **pnpm** (pnpm-lock.yaml, `node_modules/.pnpm`), though scripts are npm-compatible. Node 24.x.

```bash
pnpm dev                  # next dev on http://localhost:3000
pnpm build                # next build -> .next/
pnpm generate:starter     # regenerate lib/generated/starter-files.ts from guest/
pnpm lint                 # eslint (ignores .next, guest, lib/generated)
pnpm typecheck            # tsc over the host
pnpm typecheck:guest      # tsc over guest/ against its own tsconfig
pnpm test                 # vitest run (tests/**/*.test.ts, node env)
pnpm test:watch
pnpm test:e2e             # playwright, chromium only, auto-starts dev server
```

```bash
cd macos && make app       # -> macos/build/WebMCP Browser.app (Swift, independent of pnpm)
cd macos && make test      # node contract test for the WebMCP polyfill
cd macos && make check     # end-to-end bridge check inside a real WKWebView (needs a GUI session)
cd macos && make media-check  # microphone, Web Speech, and audio output (needs TCC grants)
cd macos && make reload-check # repeated-load regression test (needs pnpm dev on :3000)
```

Single unit test: `pnpm vitest run tests/project-policy.test.ts` (or `-t "substring of it() name"`).
Single e2e test: `pnpm playwright test -g "queues a final mocked speech transcript"`.
Set `PLAYWRIGHT_SKIP_WEBSERVER=1` to run e2e against an already-running dev server.

Running the live preview or end-to-end suite requires a Chromium browser with cross-origin isolation and third-party storage enabled; WebContainers will not boot otherwise.

Regenerating the prebuilt guest runtime (only when `guest/package.json` changes): run `pnpm dev`, open `http://localhost:3000/dev/snapshot`, click **Generate snapshot**, and save both downloads into `public/guest-runtime/`. `tests/runtime-snapshot.test.ts` fails until they match.

## Repository scope

- `app/`, `lib/`, `public/`, and `tests/` implement and verify the Formless Health host application.
- `guest/` is the guest project mounted into the WebContainer — it is source, but it is *not* host
  source: it never runs in this app's process, compiles against its own `guest/tsconfig.json` and
  React version, and is excluded from the host tsconfig and eslint config. Do not import from it
  anywhere except `lib/starter-project.ts`.
- `skills/formless-apps/` is a reusable Codex skill and protocol kit. It is not imported by or bundled into the Formless Health runtime.
- `macos/` is a standalone SwiftPM app — a generic WebMCP browser (address bar + `WKWebView` + a
  `document.modelContext` polyfill and native bridge). It is not specific to Formless Health and shares no code
  with the web app; it is useful here because Formless Health is a page that registers tools. Media capture
  there has two independent gates (a `WKUIDelegate` site prompt and macOS TCC) and must be launched
  via `open`, not by running the binary. Every user-initiated load recycles the web content process,
  because WebKit's process reuse makes this repo's WebContainer host fail after a few same-process
  loads — see `macos/README.md`.
- Generated output lives in `.next/` and `test-results/`; do not treat it as source. `lib/generated/starter-files.ts` is generated but **is** checked in — see `lib/starter-project.ts`.

## Architecture

The runtime application is a two-layer system. The **host** (this repo, Next.js App Router on Vercel) boots a WebContainer holding a **guest** React+Vite project (`guest/`, inlined by `lib/starter-project.ts`), renders it in a cross-origin iframe, and exposes sixteen WebMCP tools to a browser agent. It also serves a small versions API backed by Postgres.

```
Browser agent ──WebMCP tools──▶ Host page (app/CanvasApp.tsx)
                                    │
                    ProjectController ├──▶ WebContainer (mount prebuilt runtime, npm run dev)
                                    │
                    postMessage bridge ├──▶ iframe: guest app preview
```

### Host pieces

- `app/CanvasApp.tsx` — owns all application state: the iframe, the `postMessage` listener, the message queue, tool registration, and the version list. The UI is a header (brand, version picker, connection pill) over a full-width preview; there is no side rail. Everything else is a plain module, except `app/VersionSwitcher.tsx`, which is presentational and holds only its own disclosure and form state.
- `lib/project-controller.ts` — singleton (`getProjectController()`) that owns the WebContainer lifecycle and the authoritative in-memory `FileMap`. State machine phases are the `RuntimePhase` union in `canvas-types.ts`; the UI subscribes via `controller.subscribe()`.
- `lib/webmcp-tools.ts` — builds the sixteen `ToolDefinition`s and registers them on `document.modelContext` when native WebMCP exists. There is no in-page fallback console: without native WebMCP the tools are simply not reachable from the page, and `CanvasApp` shows "Local test bridge only".
- `lib/project-policy.ts` — path normalization + the editable-surface allowlist. `lib/persistence.ts` — IndexedDB snapshot (`webmcp-canvas`/`project-snapshots`). `lib/bridge.ts` — trusted-message predicate. `lib/hash.ts` — 16-char SHA-256 prefix. `lib/file-tree.ts` — `FileMap` → `FileSystemTree`.
- `guest/` — the entire guest project as real files at their real paths. `scripts/generate-starter-files.mjs` inlines them into `lib/generated/starter-files.ts` (checked in), filtered to an extension allowlist, stripping exactly one trailing newline per file so `starterPackageHash()` stays stable. **Re-run `pnpm generate:starter` after editing anything under `guest/`**; `tests/starter-files.test.ts` fails when the checked-in map drifts from disk. This was an `import.meta.glob(..., { query: '?raw' })` under Vite, which could not go stale — Next supports neither glob imports nor `?raw`, so the freshness guarantee moved into a test. Edit guest code as ordinary files.
  - `guest/` is excluded from the host `tsconfig.json` and `eslint.config.mjs`: it targets its own React version and imports `./agent/bridge`, so host type-checking only produces noise. Guest syntax is checked in-container by `guest/scripts/validate-syntax.mjs`, and `tests/guest-audit.test.ts` runs the instrumentation audit plus the structural invariants at host test time.
- `lib/runtime-snapshot.ts` + `public/guest-runtime/` — the prebuilt WebContainer filesystem. `app/dev/snapshot/` is the dev-only generator that produces it.
- `lib/version-store.ts` (Postgres, driver-free), `lib/version-db.ts` (the `pg` pool), `lib/version-request.ts` (auth, body limits, error mapping), `app/api/versions/**` (handlers), `lib/version-client.ts` (browser), `app/VersionSwitcher.tsx` (header UI). See **Published versions** below.

### Three invariants that drive most of the code

**1. Revision-guarded, all-or-nothing writes.** `apply_project_changes` and `reset_project` take a `baseRevision` and reject on mismatch. `ProjectController.applyChanges` snapshots the `FileMap`, writes to the container, runs `npm run validate` in the guest (45s timeout, exit 124), and on any failure calls `restoreFiles(previous)` and rethrows as "Update rolled back." Revision only increments after a snapshot is persisted. Any new mutating tool must follow the same snapshot → mutate → validate → rollback shape.

**2. Only the app surface is editable.** `EDITABLE_PATTERNS` in `project-policy.ts` permits exactly `src/App.tsx`, `src/components/**`, `src/styles/**`, `public/**`. The guest's `package.json`, `vite.config.ts`, `scripts/`, and critically `src/agent/bridge.tsx` are readable but protected — the agent cannot disable its own instrumentation. `mergeSnapshot()` on boot re-applies the starter for every non-editable path, so a stale IndexedDB snapshot can never resurrect a modified protected file.

**3. The prebuilt runtime is a cache, never a source of truth.** Boot mounts `public/guest-runtime/runtime.gz` (a `WebContainer.export('.')` of an installed, warmed guest) instead of running `npm install` — ~150ms instead of ~14s. `manifest.json` pins it to a SHA-256 of the starter `package.json`; on any mismatch, missing asset, or mount failure, `hydrateFromRuntimeSnapshot()` logs a reason and falls through to the original mount-and-install path. Nothing else may depend on the snapshot existing. Guest source always comes from `STARTER_FILES` + the IndexedDB overlay mounted *on top* of the snapshot, so a stale snapshot can only cost boot time, never content.

Two consequences to preserve when touching the guest `package.json`: a remounted snapshot loses the executable bit on `node_modules/.bin`, so guest scripts must invoke `node node_modules/<pkg>/…` rather than a bare binary (otherwise `jsh: spawn vite EACCES`); and `@rolldown/binding-wasm32-wasi` stays pinned to rolldown's version so vite does not download it on every dev-server start.

### Published versions

A version is **the editable overlay only** — `extractOverlay()` / `validateOverlay()` in `project-policy.ts`. `mergeSnapshot()` re-derives every protected file from `STARTER_FILES`, so invariant 2 holds by construction at both ends: a published version physically cannot carry a modified `src/agent/bridge.tsx` or `package.json`, however it was written. Overlays are validated on the way in *and* on the way out of the database.

- `ProjectController.loadVersion()` is the single switch path; `reset()` is `loadVersion(rev, starterOverlay())`. It deliberately **skips `npm run validate`** — an overlay can only be published from a draft that already passed validation in `applyChanges`, so a switch is `restoreFiles` plus HMR (~200ms) rather than a 45s revalidation. It still increments the revision, so an `apply_project_changes` in flight across a switch fails on a stale `baseRevision` instead of writing into the version the user just left.
- Identity is an opaque publisher token in `localStorage`; the server stores only `sha256Hex()` of it as `author_id`. There is no sign-in flow on purpose — `macos/` implements no `createWebViewWith`, so an OAuth popup would be a dead end there.
- Storage is a single Postgres table: the index columns plus the overlay in a `jsonb` column. It was D1 plus one R2 object per version on Cloudflare; neither exists on Vercel, and a 2MB overlay cap (`version-request.ts`) fits in a column. Publishing is therefore **one atomic INSERT** — the old code wrote the blob before the index row precisely because it could not be. `version-store.ts` takes a `SqlClient` and imports no driver, which is what keeps it testable under the node environment; `lib/version-db.ts` owns the memoized `pg` pool. `ensureSchema()` applies the schema lazily, so an empty database works with no migration step.
- `created_at` is TEXT holding an ISO-8601 UTC string, carried over from D1 rather than converted to `timestamptz`: the rate limiter compares it as a string, and ISO-8601 UTC sorts lexicographically the same way it sorts chronologically.
- `listVersions` deliberately does not select `overlay`; listing every version would otherwise pull up to 2MB of source per row to render a dropdown.
- A missing `POSTGRES_URL` is a **soft failure**: the routes answer 503 and the header degrades, matching `fetchRuntimeSnapshot()`'s posture. Never make the canvas depend on the backend being present.
- The preview iframe drops `microphone` from `allow` while a version the viewer did not publish is loaded; `allow` is read at load, so it is part of the iframe `key`.
- Persisted identifiers still carry the old `webally-` prefix on purpose, and the product rename to Formless Health
  deliberately left them alone: the IndexedDB name `webally-health` and its AES-GCM AAD `webally-health/record/v1`
  (`lib/health/storage.ts`), the publisher token key and its server-side digest prefix `webally-publisher/v1:`
  (`lib/version-client.ts`, `lib/version-store.ts`), the guest state prefix (`lib/guest-state.ts`), and the auth
  channel names (`lib/health/session.ts`). Renaming the AAD makes every existing encrypted record permanently
  undecryptable; renaming the digest prefix strips every existing publisher of the ability to rename or unpublish
  their versions. These are invisible to users — treat them as wire format, not branding.
- The macOS shell gets this page-level only, via `?version=<id>`. Do not add a versions panel specific to Formless Health to `macos/` — it is a browser for any site.

### The bridge (host ↔ guest)

Protocol constant `webmcp-canvas/v1` is duplicated: `BRIDGE_PROTOCOL` in `lib/canvas-types.ts` and a `PROTOCOL` literal in `guest/src/agent/bridge.tsx`. Change both together.

- Host → guest: `highlight`, `clear-highlight`, posted to the exact preview origin.
- Guest → host: `registry` (instrumented element descriptors), `coverage` (instrumentation audit result), `user-message` (typed / final-speech text).
- Host origin reaches the guest via the `?canvasHost=` query param on the iframe `src`; the guest pins `hostOrigin` from it. Host-side, `isTrustedPreviewMessage` requires matching source window **and** exact origin **and** protocol — do not relax any of the three.

Guest UI is instrumented with `AgentTarget` / `AgentButton` / `AgentInput` from `src/agent/bridge.tsx`; the guest's `scripts/audit-ui.mjs` fails validation on any raw `<button>`/`<input>`/`<a>` JSX or duplicate `agentId`, so agent-authored guest UI must use the wrappers. `scripts/validate-syntax.mjs` transpile-checks all guest `src/**/*.ts(x)` — syntax only, not full type-checking.

### Guest capabilities (host-mediated)

The guest is a real application now, and real applications need routes, storage,
and a way to sign in. It gets all three by asking the host, never by doing them
itself. `lib/host-capabilities.ts` is the dispatcher; `guest/src/agent/bridge.tsx`
is the guest half. Both are protected files.

- Guest -> host: `manifest` (declared routes + wanted capabilities) and
  `host-request` (`{id, method, params}`). Host -> guest: `host-response`
  (`{id, ok, value|error}`) and `host-event` (`auth.changed`, `record.changed`,
  `navigate`, `import.started`, `import.progress`, `import.finished`). All
  additive to `webmcp-canvas/v1`; an older published version that sends no
  `manifest` simply declares no routes, and one that ignores the import events
  simply does not narrate the download.
- Methods: `state.get/set/delete`, `auth.status/connect/disconnect`,
  `record.get/unlock/lock/clear/download`.
- **`computeGrant()` is the security boundary.** The starter and versions *you*
  published are privileged; anything else gets namespaced `state.*` and is
  refused `auth.*` and `record.*` outright. This is the same rule `previewAllow`
  already applies to the microphone, for the same reason: a published version is
  a stranger's code. `tests/host-capabilities.test.ts` pins it. `state.*` scopes
  are per-version, so one version cannot read another's keys.
- The token and the Argon2id-derived key never cross the bridge. The passphrase
  prompt is deliberately host chrome (`app/PassphrasePrompt.tsx`), not guest UI —
  a passphrase field rendered inside the preview would be one an agent, or a
  published version, controls.
- `navigate_to_route` is built from the declared routes only, so the agent can
  never navigate the preview somewhere it cannot render. For a voice user this is
  the point: "take me to my record" beats hunting for a link.

### Health subsystem

`lib/health/**` is ported from the sibling `yesyouhealth` Next.js app (read-only;
do not modify it). `epic.ts` and `providers.ts` are verbatim, `encryption.ts` is
verbatim, `types.ts`/`storage.ts`/`session.ts`/`import.ts` are adapted.

- All of it is browser code and always was: PKCE public client, no secret, token
  exchange in the page. What changed is *which* page. Epic can never register the
  WebContainer's ephemeral origin as a `redirect_uri`, so the host runs OAuth on
  its own stable origin and hands the guest a decrypted record.
- **COOP `same-origin` severs `window.opener`**, so the popup cannot post back.
  `lib/health/session.ts` opens the popup at a *same-origin* `/health/connect`
  which then redirects itself to Epic, and the result returns over
  `BroadcastChannel`. A consequence: the host cannot poll `popup.closed`, so
  abandonment is caught by timeout, not polling.
- **This flow cannot work in `macos/`** — no `createWebViewWith`, so
  `window.open` does nothing. That is detected via a `started` heartbeat and
  reported, rather than hanging. Accepted trade-off of the popup approach.
- The agent cannot start a sign-in: `window.open` needs transient user
  activation, so a popup opened from a tool call is blocked. Auth stays a user
  gesture; the agent's role is `navigate_to_route` and highlighting.
- `NEXT_PUBLIC_EPIC_CLIENT_ID` enables it. Missing config is a **soft failure**: the
  connect panel says so and `/explore` still serves `public/demo/`'s
  de-identified sample. Never make the canvas depend on it.
- The demo fixture lives in the **host's** `public/`, not the guest's: at ~4.5MB
  it would exceed the overlay limits (256KB/file, 1MB/batch) and the 2MB publish
  body cap.
- **The import narrates itself to the guest.** A real export is 27 searches and
  thousands of resources over a minute or more, so the guest switches to its
  record view when the download starts and shows the count climbing:
  `connectAndImport` fires `onImportStart` once `authorize()` returns a token —
  not when the user clicked connect, since sign-in happens in a popup at the
  user's own pace — and `lib/health/import-relay.ts` turns the progress
  callbacks into throttled `host-event`s. `epic.ts` reports per *page* of
  results, so unthrottled that is hundreds of `postMessage`s per import.
  Two rules make it safe. `createHealthPort` answers `record.get` with
  **nothing** while an import is running: the store is still `empty` for that
  whole window, so the fallback would otherwise hand the guest the
  de-identified sample to show under the patient's own heading. And
  `import.finished` carries the failure when there is one — by then the guest
  may have left the landing page, which is the only place a connect error is
  rendered.

### The page's voice

`lib/speech.ts` owns `window.speechSynthesis` for the host page and backs `speak_text` /
`stop_speaking`. It is host-owned on purpose — the same rule as the microphone and `computeGrant()`:
a published version is a stranger's code and does not get the speaker. The port takes its
synthesizer and utterance factory as arguments so `tests/speech.test.ts` can drive it under the
node environment.

Two browser facts are baked into it and should not be "simplified" away. **Chrome refuses
`speechSynthesis.speak()` on a document with no user activation** (`error: 'not-allowed'`), and this
document rarely has one, because the user's clicks land inside the cross-origin preview iframe. That
is the entire reason `app/VoicePill.tsx` exists: its first click speaks a silent primer and arms the
engine, and a `not-allowed` error afterwards sets `blocked` so the header says why nothing was said.
`macos/` needs none of it (`mediaTypesRequiringUserActionForPlayback = []`). And **Chrome's
synthesis watchdog truncates utterances past roughly fifteen seconds**, so a `resume()` heartbeat
runs every ten seconds while speech is in flight. `speak()` resolves on `end`, caps the wait at 60s
(resolving `stillSpeaking` without cancelling), and treats `interrupted`/`canceled` as success —
`stop_speaking` and `interrupt: true` both produce it deliberately.

### Messages are pull-only

`UserMessageQueue` (cap 50) holds typed input and final speech transcripts session-only — never persisted, and never rendered: `poll_user_messages` is the only reader. The page cannot push to the agent; the agent is expected to call `poll_user_messages` with a monotonic `afterId` roughly every two seconds.

## Formless Apps skill

`skills/formless-apps/SKILL.md` is the entrypoint. Keep conditional detail in its linked resources:

- `references/protocol.md` defines the project-level `formless-apps/1.0` convention and eight `formless_apps.*` tools.
- `references/system-prompt.md` contains the trusted agent-side prompt. Website-controlled content must never be inserted into that prompt.
- `references/implementation.md` explains website integration and verification.
- `assets/formless-apps-starter.ts` is the framework-neutral implementation starter copied into generated work.

Formless Apps is layered on WebMCP; do not describe it as part of the WebMCP standard. Current examples use `document.modelContext`, registration-owned `AbortSignal` cleanup, and `readOnlyHint` / `untrustedContentHint`. Do not reintroduce stale `navigator.modelContext`, `provideContext()`, `clearContext()`, or name-based `unregisterTool()` examples.

Preserve the protocol's trust boundary: the system prompt is installed outside the page, handshake and tool output remain untrusted data, sessions are bound to origin/document/principal, mutations are revision-guarded, and consequential actions use preview plus fresh confirmation. Formless Apps augments semantic HTML, keyboard support, focus management, and accessible status/error handling; it does not replace them.

## Cross-origin isolation

COOP/COEP headers are set in **two** places and must stay consistent: `proxy.ts` (Next middleware) and `next.config.ts` (`headers()`). Dropping either breaks `WebContainer.boot({ coep: 'require-corp' })`. Both also set `Cross-Origin-Resource-Policy: cross-origin`. There was a third copy in `vite.config.ts` for the Vite dev server; `next dev` honours `next.config.ts` directly, so it is gone.

## Deployment

Vercel, as a stock Next.js app — there is no adapter, no `vite.config.ts`, and no deployment plugin. Set `POSTGRES_URL` (or `DATABASE_URL`) to a **pooled** endpoint: serverless functions open a connection per warm instance, so a direct endpoint will exhaust its connection limit.

Client-visible configuration is `NEXT_PUBLIC_`-prefixed and inlined at **build** time, so it must be set when `next build` runs, not added afterwards. Next substitutes those statically, which is why `lib/health/port.ts` writes each variable as a literal `process.env.NEXT_PUBLIC_X` member access inside `clientEnv()` rather than indexing `process.env` by a computed name — a dynamic read is never substituted and silently reads as undefined in the browser.

This app previously deployed to OpenAI Sites on Cloudflare Workers via `vinext` (a Vite reimplementation of Next), `@cloudflare/vite-plugin`, and `@openai/sites-vite-plugin`, with `.openai/hosting.json` naming the D1/R2 bindings. All of that is gone.

## Testing shape

Unit tests are node-environment and cover pure modules only (policy, queue, bridge predicate, tool contracts with a mocked controller) — no WebContainer, no jsdom. Three suites were added with the guest port: `tests/guest-audit.test.ts` runs the instrumentation audit and structural invariants over `guest/src` in milliseconds, instead of only discovering a violation after a 45s in-container `validate`; `tests/host-capabilities.test.ts` pins the capability grant policy; `tests/health-storage.test.ts` uses `fake-indexeddb` to check the record is unreadable without its passphrase. `tests/webmcp-tools.test.ts` asserts the exact tool name list and order; adding or renaming a tool requires updating it, along with the same list and the literal tool count in `e2e/canvas.spec.ts`. `tests/speech.test.ts` drives `createSpeechPort` against an injected fake synthesizer, which is why the port takes one. `tests/import-relay.test.ts` does the same for the import relay with fake timers — it pins the ordering the guest's progress view depends on (nothing before a start, nothing after a finish, the last report always lands), which is why the relay takes its emitter and interval as arguments. `tests/runtime-snapshot.test.ts` reads `public/guest-runtime/` off disk and is the guard against shipping a snapshot built from a different guest `package.json`. E2E drives the real WebContainer boot, so the speech test allows a 90s wait and injects a mock `SpeechRecognition` via `addInitScript`. Since nothing in the page invokes tools any more, `e2e/canvas.spec.ts` installs a minimal `document.modelContext` via `addInitScript` and calls the registered descriptors directly. That stub must honour the registration `AbortSignal`: `registerNativeTools` re-registers whenever the preview origin changes, and a stub that keeps aborted descriptors hands tests a stale tool reporting that the live preview is not ready.

Changes to `skills/formless-apps/assets/formless-apps-starter.ts` must also pass strict standalone compilation:

```bash
pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM skills/formless-apps/assets/formless-apps-starter.ts
```

After changing any skill file, run the active `skill-creator` validator against `skills/formless-apps`. Also exercise negotiation, invalid sessions, stale revisions, cancellation, principal changes, and confirmation-token behavior when the corresponding contract changes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
