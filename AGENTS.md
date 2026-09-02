# AGENTS.md

This file provides repository-specific guidance to coding agents. Keep it focused on non-obvious architecture, invariants, and verification requirements; use `README.md` for user-facing setup.

## Commands

Package manager is **pnpm** (pnpm-lock.yaml, `node_modules/.pnpm`), though scripts are npm-compatible. Node >= 22.13.0.

```bash
pnpm dev                  # vinext dev on http://localhost:3000
pnpm build                # vinext build -> dist/
pnpm lint                 # eslint (ignores dist, .next)
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

Regenerating the prebuilt guest runtime (only when `lib/starter-project.ts`'s `package.json` changes): run `pnpm dev`, open `http://localhost:3000/dev/snapshot`, click **Generate snapshot**, and save both downloads into `public/guest-runtime/`. `tests/runtime-snapshot.test.ts` fails until they match.

## Repository scope

- `app/`, `lib/`, `public/`, and `tests/` implement and verify the WebAlly application.
- `skills/web-ally/` is a reusable Codex skill and protocol kit. It is not imported by or bundled into the WebAlly runtime.
- `macos/` is a standalone SwiftPM app — a generic WebMCP browser (address bar + `WKWebView` + a
  `document.modelContext` polyfill and native bridge). It is not WebAlly-specific and shares no code
  with the web app; it is useful here because WebAlly is a page that registers tools. Media capture
  there has two independent gates (a `WKUIDelegate` site prompt and macOS TCC) and must be launched
  via `open`, not by running the binary. Every user-initiated load recycles the web content process,
  because WebKit's process reuse makes this repo's WebContainer host fail after a few same-process
  loads — see `macos/README.md`.
- Generated output lives in `dist/`, `.next/`, `.vinext/`, `.wrangler/`, and `test-results/`; do not treat it as source.

## Architecture

The runtime application is a two-layer system. The **host** (this repo, Next.js App Router via `vinext` on Cloudflare Workers) boots a WebContainer holding a **guest** React+Vite project (`lib/starter-project.ts`), renders it in a cross-origin iframe, and exposes thirteen WebMCP tools to a browser agent. It also serves a small versions API backed by D1 and R2.

```
Browser agent ──WebMCP tools──▶ Host page (app/CanvasApp.tsx)
                                    │
                    ProjectController ├──▶ WebContainer (mount prebuilt runtime, npm run dev)
                                    │
                    postMessage bridge ├──▶ iframe: guest app preview
```

### Host pieces

- `app/CanvasApp.tsx` — owns all application state: the iframe, the `postMessage` listener, the message queue, tool registration, and the version list. Everything else is a plain module, except `app/VersionSwitcher.tsx`, which is presentational and holds only its own disclosure and form state.
- `lib/project-controller.ts` — singleton (`getProjectController()`) that owns the WebContainer lifecycle and the authoritative in-memory `FileMap`. State machine phases are the `RuntimePhase` union in `canvas-types.ts`; the UI subscribes via `controller.subscribe()`.
- `lib/webmcp-tools.ts` — builds the thirteen `ToolDefinition`s and registers them on `document.modelContext` when native WebMCP exists. When it doesn't, `CanvasApp`'s collapsible "Tool console" invokes the *same* descriptors, so there is one code path either way.
- `lib/project-policy.ts` — path normalization + the editable-surface allowlist. `lib/persistence.ts` — IndexedDB snapshot (`webmcp-canvas`/`project-snapshots`). `lib/bridge.ts` — trusted-message predicate. `lib/hash.ts` — 16-char SHA-256 prefix. `lib/file-tree.ts` — `FileMap` → `FileSystemTree`.
- `lib/starter-project.ts` — the entire guest project as a `FileMap` of template-literal source strings. Editing guest code means editing strings here; backticks, `${`, and backslashes in regexes must be escaped.
- `lib/runtime-snapshot.ts` + `public/guest-runtime/` — the prebuilt WebContainer filesystem. `app/dev/snapshot/` is the dev-only generator that produces it.
- `lib/version-store.ts` (D1 + R2), `lib/version-request.ts` (auth, body limits, error mapping), `app/api/versions/**` (handlers), `lib/version-client.ts` (browser), `app/VersionSwitcher.tsx` (header UI). See **Published versions** below.

### Three invariants that drive most of the code

**1. Revision-guarded, all-or-nothing writes.** `apply_project_changes` and `reset_project` take a `baseRevision` and reject on mismatch. `ProjectController.applyChanges` snapshots the `FileMap`, writes to the container, runs `npm run validate` in the guest (45s timeout, exit 124), and on any failure calls `restoreFiles(previous)` and rethrows as "Update rolled back." Revision only increments after a snapshot is persisted. Any new mutating tool must follow the same snapshot → mutate → validate → rollback shape.

**2. Only the app surface is editable.** `EDITABLE_PATTERNS` in `project-policy.ts` permits exactly `src/App.tsx`, `src/components/**`, `src/styles/**`, `public/**`. The guest's `package.json`, `vite.config.ts`, `scripts/`, and critically `src/agent/bridge.tsx` are readable but protected — the agent cannot disable its own instrumentation. `mergeSnapshot()` on boot re-applies the starter for every non-editable path, so a stale IndexedDB snapshot can never resurrect a modified protected file.

**3. The prebuilt runtime is a cache, never a source of truth.** Boot mounts `public/guest-runtime/runtime.gz` (a `WebContainer.export('.')` of an installed, warmed guest) instead of running `npm install` — ~150ms instead of ~14s. `manifest.json` pins it to a SHA-256 of the starter `package.json`; on any mismatch, missing asset, or mount failure, `hydrateFromRuntimeSnapshot()` logs a reason and falls through to the original mount-and-install path. Nothing else may depend on the snapshot existing. Guest source always comes from `STARTER_FILES` + the IndexedDB overlay mounted *on top* of the snapshot, so a stale snapshot can only cost boot time, never content.

Two consequences to preserve when touching the guest `package.json`: a remounted snapshot loses the executable bit on `node_modules/.bin`, so guest scripts must invoke `node node_modules/<pkg>/…` rather than a bare binary (otherwise `jsh: spawn vite EACCES`); and `@rolldown/binding-wasm32-wasi` stays pinned to rolldown's version so vite does not download it on every dev-server start.

### Published versions

A version is **the editable overlay only** — `extractOverlay()` / `validateOverlay()` in `project-policy.ts`. `mergeSnapshot()` re-derives every protected file from `STARTER_FILES`, so invariant 2 holds by construction at both ends: a published version physically cannot carry a modified `src/agent/bridge.tsx` or `package.json`, however it was written. Overlays are validated on the way in *and* on the way out of R2.

- `ProjectController.loadVersion()` is the single switch path; `reset()` is `loadVersion(rev, starterOverlay())`. It deliberately **skips `npm run validate`** — an overlay can only be published from a draft that already passed validation in `applyChanges`, so a switch is `restoreFiles` plus HMR (~200ms) rather than a 45s revalidation. It still increments the revision, so an `apply_project_changes` in flight across a switch fails on a stale `baseRevision` instead of writing into the version the user just left.
- Identity is an opaque publisher token in `localStorage`; the server stores only `sha256Hex()` of it as `author_id`. There is no sign-in flow on purpose — `macos/` implements no `createWebViewWith`, so an OAuth popup would be a dead end there.
- Bindings come from `.openai/hosting.json` (`"d1": "DB"`, `"r2": "VERSIONS"`) and are read with `import { env } from 'cloudflare:workers'` in the route files only, never in `lib/` — that is what keeps `version-store.ts` testable under the node environment. `ensureSchema()` applies the schema lazily per isolate because `vite.config.ts` pins a placeholder `database_id`.
- Missing bindings are a **soft failure**: the routes answer 503 and the header degrades, matching `fetchRuntimeSnapshot()`'s posture. Never make the canvas depend on the backend being present.
- The preview iframe drops `microphone` from `allow` while a version the viewer did not publish is loaded; `allow` is read at load, so it is part of the iframe `key`.
- The macOS shell gets this page-level only, via `?version=<id>`. Do not add a WebAlly-specific versions panel to `macos/` — it is a browser for any site.

### The bridge (host ↔ guest)

Protocol constant `webmcp-canvas/v1` is duplicated: `BRIDGE_PROTOCOL` in `lib/canvas-types.ts` and a `PROTOCOL` literal inside the `src/agent/bridge.tsx` string in `starter-project.ts`. Change both together.

- Host → guest: `highlight`, `clear-highlight`, posted to the exact preview origin.
- Guest → host: `registry` (instrumented element descriptors), `coverage` (instrumentation audit result), `user-message` (typed / final-speech text).
- Host origin reaches the guest via the `?canvasHost=` query param on the iframe `src`; the guest pins `hostOrigin` from it. Host-side, `isTrustedPreviewMessage` requires matching source window **and** exact origin **and** protocol — do not relax any of the three.

Guest UI is instrumented with `AgentTarget` / `AgentButton` / `AgentInput` from `src/agent/bridge.tsx`; the guest's `scripts/audit-ui.mjs` fails validation on any raw `<button>`/`<input>`/`<a>` JSX or duplicate `agentId`, so agent-authored guest UI must use the wrappers. `scripts/validate-syntax.mjs` transpile-checks all guest `src/**/*.ts(x)` — syntax only, not full type-checking.

### Messages are pull-only

`UserMessageQueue` (cap 50) holds typed input and final speech transcripts session-only — never persisted. The page cannot push to the agent; the agent is expected to call `poll_user_messages` with a monotonic `afterId` roughly every two seconds.

## Web Ally skill

`skills/web-ally/SKILL.md` is the entrypoint. Keep conditional detail in its linked resources:

- `references/protocol.md` defines the project-level `web-ally/1.0` convention and eight `web_ally.*` tools.
- `references/system-prompt.md` contains the trusted agent-side prompt. Website-controlled content must never be inserted into that prompt.
- `references/implementation.md` explains website integration and verification.
- `assets/web-ally-starter.ts` is the framework-neutral implementation starter copied into generated work.

Web Ally is layered on WebMCP; do not describe it as part of the WebMCP standard. Current examples use `document.modelContext`, registration-owned `AbortSignal` cleanup, and `readOnlyHint` / `untrustedContentHint`. Do not reintroduce stale `navigator.modelContext`, `provideContext()`, `clearContext()`, or name-based `unregisterTool()` examples.

Preserve the protocol's trust boundary: the system prompt is installed outside the page, handshake and tool output remain untrusted data, sessions are bound to origin/document/principal, mutations are revision-guarded, and consequential actions use preview plus fresh confirmation. Web Ally augments semantic HTML, keyboard support, focus management, and accessible status/error handling; it does not replace them.

## Cross-origin isolation

COOP/COEP headers are set in **three** places and must stay consistent: `vite.config.ts` (`server.headers`, dev), `proxy.ts` (Next middleware, runtime), and `next.config.ts` (`headers()`). Dropping any one breaks `WebContainer.boot({ coep: 'require-corp' })`. `next.config.ts` and `proxy.ts` also set `Cross-Origin-Resource-Policy: cross-origin`.

## Deployment

Cloudflare Workers via `@cloudflare/vite-plugin` + wrangler. Bindings are driven by `.openai/hosting.json` (`d1`/`r2`, both `null` today) — set a binding name there rather than hand-writing wrangler config in `vite.config.ts`. Wrangler/Miniflare state is forced project-local into `.wrangler/` by `vite.config.ts`. An optional `VITE_WEBCONTAINER_API_KEY` is passed to `configureAPIKey` when present.

## Testing shape

Unit tests are node-environment and cover pure modules only (policy, queue, bridge predicate, tool contracts with a mocked controller) — no WebContainer, no jsdom. `tests/webmcp-tools.test.ts` asserts the exact tool name list and order; adding or renaming a tool requires updating it. `tests/runtime-snapshot.test.ts` reads `public/guest-runtime/` off disk and is the guard against shipping a snapshot built from a different guest `package.json`. E2E drives the real WebContainer boot, so the speech test allows a 90s wait and injects a mock `SpeechRecognition` via `addInitScript`.

Changes to `skills/web-ally/assets/web-ally-starter.ts` must also pass strict standalone compilation:

```bash
pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM skills/web-ally/assets/web-ally-starter.ts
```

After changing any skill file, run the active `skill-creator` validator against `skills/web-ally`. Also exercise negotiation, invalid sessions, stale revisions, cancellation, principal changes, and confirmation-token behavior when the corresponding contract changes.
