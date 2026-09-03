# Formless Labs

Formless Labs is a preview-first demo of a browser agent inspecting, navigating, and updating a live React project. The outer host boots a WebContainer, mounts the protected guest project, and exposes nineteen WebMCP tools. The guest runs in a cross-origin iframe and reports its instrumented UI elements to the host through a versioned bridge.

The guest is **Formless Health** — a patient-authorized health record app with two routes, a landing page and a record explorer. It is a real interface rather than a synthetic demo, which is the point: a dense clinical record with 1,400+ resources across 17 types is exactly the kind of thing that is hard to navigate by hand and worth driving by voice.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in a Chromium browser. WebContainers require cross-origin isolation; the development server and proxy both add the required COOP/COEP headers. The page is the live preview plus a header: a version picker and the WebMCP connection state. Tools are exposed to the browser agent only - there is no in-page tool console, so a browser without native WebMCP can view the preview and switch versions but cannot invoke tools.

## The guest app

Guest source lives in `guest/` as ordinary files and is inlined into a `FileMap`
in `lib/generated/starter-files.ts`. Edit it like any other project, then run
`pnpm generate:starter` — `pnpm test` fails while the generated map is stale.
`pnpm typecheck:guest` type-checks it, and `pnpm test` runs the instrumentation
audit over it.

Everything interactive must go through `AgentTarget` / `AgentButton` /
`AgentInput` / `AgentLink` from `src/agent/bridge` — a raw `<button>` or `<a>` in
guest JSX fails the audit and rolls the whole change back.

### Host capabilities

The guest holds no credentials. It declares its routes on mount and asks the
host for anything privileged over the bridge:

- `state.*` — per-version key/value storage on the host origin. The preview gets
  a fresh origin on every boot, so guest-side storage would not survive a reload.
- `auth.*` / `record.*` — sign-in and the health record.

Versions **you** published (and the starter) get all of it. A version published
by someone else gets namespaced state and is refused the record — the same rule
the microphone already follows.

## Connecting a real record

```bash
cp .env.example .env.local     # then fill in NEXT_PUBLIC_EPIC_CLIENT_ID
pnpm dev                       # env is read at startup — restart to pick it up
```

Register `<origin>/health/callback` as the redirect URI in your Epic app
(`http://localhost:3000/health/callback` for local development). Epic issues
separate non-production and production client ids for the same app, so
`NEXT_PUBLIC_EPIC_SANDBOX_CLIENT_ID` overrides the id for the Epic Sandbox provider.

One production client id covers every organization: Epic registers the app once
and each customer health system enables it. The organizations you can search for
come from `public/directory/epic-r4.json`, a committed snapshot of Epic's
published endpoint list. Refresh it with:

```bash
pnpm generate:directory        # re-reads https://open.epic.com/Endpoints/R4
```

Organizations needing a hand-written portal name, scope, or capability override
go in `lib/health/providers.ts`, which wins over the snapshot on id.

These are `NEXT_PUBLIC_`-prefixed because they are inlined at **build** time, so
a deployed build needs them set when `pnpm build` runs — not added afterwards. That is safe: a PKCE client id is public by design and there is no
client secret in this flow. The host runs the PKCE flow on its own stable
origin, because the WebContainer's origin is ephemeral and can never be
registered; the guest only ever receives a decrypted record. The record is
encrypted at rest with Argon2id + AES-GCM, and the key never leaves the host page.

Without that variable everything still works: the connect panel says it is not
configured and the explorer shows a de-identified sample record.

Two known limits. Sign-in uses a popup and `BroadcastChannel` (the page's
`Cross-Origin-Opener-Policy` severs `window.opener`), so it does **not** work in
the macOS shell, which cannot open popups. And an agent cannot start a sign-in:
popups need a real user gesture.

## Versions

Any interface you build can be published as a named **version** that everyone who opens Formless Labs
sees in the header dropdown. Clicking one loads it into the live preview; `?version=<id>` opens
it directly, which is how the macOS shell boots into a specific version:

```bash
open "macos/build/WebMCP Browser.app" --args --url "http://localhost:3000/?version=<id>"
```

A version stores only the editable overlay (`src/App.tsx`, `src/components/**`, `src/styles/**`,
`public/**`) — every protected file is re-derived from the starter, so a published version can
never carry a modified bridge or build script. Metadata and the overlay live in one Postgres row,
configured by `POSTGRES_URL`; a deployment without it still runs, with the header reporting
that versions are unavailable.

Publishing needs no account. The browser mints an opaque publisher token on first publish and
keeps it in `localStorage`; the server stores only a digest of it, and it is what lets you rename
or unpublish your own versions. Everything published is publicly readable. A version you did not
publish runs without microphone access in the preview frame.

## Tools

- `get_website_summary` (the startup entry point for agents)
- `get_website_prompt`
- `list_project_files`
- `read_project_files`
- `apply_project_changes`
- `reset_project`
- `get_ui_elements`
- `highlight_ui_elements`
- `clear_ui_highlights`
- `poll_user_messages`
- `speak_text` (the page says it out loud)
- `stop_speaking`
- `get_health_summary` (what the record holds, over what dates)
- `list_health_records`
- `read_health_records` (labelled fields, verbatim FHIR, or clinical-note prose)
- `list_app_versions`
- `publish_app_version`
- `switch_app_version`
- `navigate_to_route` (moves the preview between the routes the guest declares)

The record is readable by the agent, not just by the guest. `get_health_summary` reports what the record
holds and whether it is the user's own or the de-identified sample; `list_health_records` pages it as dated,
titled lines; `read_health_records` returns the verbatim FHIR, or the decoded prose of a clinical note. All
three refuse while a version published by someone else is loaded — the same `computeGrant()` rule the bridge
applies, because guest-authored UI labels reach the agent through `get_ui_elements`.

Speech is host-owned: `speak_text` runs the browser's own synthesizer on the host page, never in the
preview, so a published version cannot drive the speaker. Chrome refuses to speak on a page with no
user activation and the host page rarely gets one — clicks land inside the preview iframe — so the
first pointer or key event anywhere on the host page arms the synthesizer with a silent primer. The
macOS shell needs no such gesture.

Code writes are revisioned, restricted to the editable application surface, checked for instrumentation and TypeScript syntax, and rolled back on failure. Validated snapshots persist in IndexedDB. Typed messages and final speech transcripts remain session-only. Publishing and switching versions are both revision-guarded and require explicit confirmation.

## Verification

```bash
npm test
npm run lint
npm run build
npm run test:e2e
```

The browser-agent harness is responsible for polling `poll_user_messages` approximately every two seconds. The page exposes the tool; it cannot schedule agent calls.
