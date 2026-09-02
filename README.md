# WebAlly

WebAlly is a preview-first demo of a browser agent inspecting and updating a live React project. The outer host boots a WebContainer, mounts the protected starter project, and exposes thirteen WebMCP tools. The editable project runs in a cross-origin iframe and reports its instrumented UI elements to the host through a versioned bridge.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in a Chromium browser. WebContainers require cross-origin isolation; the development server and proxy both add the required COOP/COEP headers. If native WebMCP is unavailable, the collapsible local tool console invokes the same typed tool descriptors.

## Versions

Any interface you build can be published as a named **version** that everyone who opens WebAlly
sees in the header dropdown. Clicking one loads it into the live preview; `?version=<id>` opens
it directly, which is how the macOS shell boots into a specific version:

```bash
open "macos/build/WebMCP Browser.app" --args --url "http://localhost:3000/?version=<id>"
```

A version stores only the editable overlay (`src/App.tsx`, `src/components/**`, `src/styles/**`,
`public/**`) — every protected file is re-derived from the starter, so a published version can
never carry a modified bridge or build script. Metadata lives in D1, the overlay in R2; both
binding names come from `.openai/hosting.json`, and a deployment without them still runs, with
the header reporting that versions are unavailable.

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
- `list_app_versions`
- `publish_app_version`
- `switch_app_version`

Code writes are revisioned, restricted to the editable application surface, checked for instrumentation and TypeScript syntax, and rolled back on failure. Validated snapshots persist in IndexedDB. Typed messages and final speech transcripts remain session-only. Publishing and switching versions are both revision-guarded and require explicit confirmation.

## Verification

```bash
npm test
npm run lint
npm run build
npm run test:e2e
```

The browser-agent harness is responsible for polling `poll_user_messages` approximately every two seconds. The page exposes the tool; it cannot schedule agent calls.
