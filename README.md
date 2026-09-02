# WebAlly

WebAlly is a preview-first demo of a browser agent inspecting and updating a live React project. The outer host boots a WebContainer, mounts the protected starter project, and exposes nine WebMCP tools. The editable project runs in a cross-origin iframe and reports its instrumented UI elements to the host through a versioned bridge.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in a Chromium browser. WebContainers require cross-origin isolation; the development server and proxy both add the required COOP/COEP headers. If native WebMCP is unavailable, the collapsible local tool console invokes the same typed tool descriptors.

## Tools

- `get_website_summary` (the startup entry point for agents)
- `list_project_files`
- `read_project_files`
- `apply_project_changes`
- `reset_project`
- `get_ui_elements`
- `highlight_ui_elements`
- `clear_ui_highlights`
- `poll_user_messages`

Code writes are revisioned, restricted to the editable application surface, checked for instrumentation and TypeScript syntax, and rolled back on failure. Validated snapshots persist in IndexedDB. Typed messages and final speech transcripts remain session-only.

## Verification

```bash
npm test
npm run lint
npm run build
npm run test:e2e
```

The browser-agent harness is responsible for polling `poll_user_messages` approximately every two seconds. The page exposes the tool; it cannot schedule agent calls.
