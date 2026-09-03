# WebMCP Browser (macOS)

A minimal native browser — address bar, `WKWebView`, and a WebMCP inspector — for any site,
not just the one in this repo. macOS supplies no `document.modelContext`, so the app injects a
polyfill into every page it loads and reports what the page registers back to Swift. The
sidebar shows whether WebMCP is **on or off** for the current page, lists the registered tools,
and can invoke one by hand. An LLM tool-selection loop is not wired up yet; it will be another
caller of `WebMCPBridge.invoke(name:argsJSON:)`.

## Build and run

```bash
cd macos
make app                  # -> build/WebMCP Browser.app
make run                  # build, then open it
make test                 # node contract test for the polyfill (no browser needed)
make check                # end-to-end: drives both channels inside a real WKWebView
make permissions          # trigger the macOS microphone / speech prompts up front
make media-check          # microphone, Web Speech, and audio output, end to end
make reload-check         # regression test for the web-content-process leak
```

Requires Xcode's toolchain (Swift 6, macOS 14+ deployment target). No third-party dependencies
and no `.xcodeproj`; `Package.swift` also opens directly in Xcode for debugging.

The app starts with a blank page. To boot straight into a URL:

```bash
open "build/WebMCP Browser.app" --args --url http://localhost:3000
WEBMCP_HOME=https://example.com make run
```

## Verifying the bridge

`make check` is the fast loop. It runs the node contract test, then loads `Tests/fixture.html`
headlessly and asserts the discovery and invocation paths, then asserts a page that registers
nothing reports **off**. The same flag works against any site:

```bash
"build/WebMCP Browser.app/Contents/MacOS/WebMCPBrowser" \
  --selfcheck http://localhost:3000 --invoke get_website_summary --settle 6
```

It prints a JSON report (`webmcp: on|off`, the tool list with frame and hints, the invocation
result, `systemPermissions`, captured `console` output) and exits non-zero when no tools appear
or an invocation fails. Other flags: `--eval <js>` evaluates an expression in the page,
`--console` includes captured console output, `--reloads N --ready-timeout S` measures
time-to-ready across repeated loads, and `--out <file>` is required whenever the app is started
with `open` (a launched app has no usable stdout). Against this repo's
dev server it reports the 9 Formless Health tools, and the WebContainer preview does boot in WebKit —
in about 1.5–4s per load, once each load gets its own process.

## Why every load starts a new process

WebKit reuses a single web content process across same-origin loads, and a document that
allocates a large heap does not fully give it back. A page that boots a WebContainer (a big
`WebAssembly.Memory` plus `SharedArrayBuffer`) therefore degrades within a few loads: it stalls
partway through boot, then fails outright with `RangeError: Out of memory`. Measured against
`http://localhost:3000`, 8 reloads plus the initial load:

| Load path | Reached a ready runtime |
| --- | --- |
| `webView.reload()` — same process | **2/9**, then out of memory |
| Address-bar load — same process | **5/9**, then out of memory |
| Fresh process per load | **9/9**, no console errors |

So `loadCurrentAddress()` and `reload()` both call `recycleWebView(loading:)`, which throws away
the `WKWebView` and builds a new one from a new `WKWebViewConfiguration` (a new configuration
means a new process pool, and therefore a genuinely new process). Cost is roughly 100ms.
`webViewWebContentProcessDidTerminate` recycles too, so a page that kills its process recovers
instead of going permanently blank.

**⇧⌘R is the escape hatch**: an ordinary in-process reload that keeps session storage and the
back/forward list. On a heap-hungry page it is also the path that degrades — 1/9 in the same
measurement — which is WebKit's behavior, not a bug in the shell. Back/forward navigation stays
in-process for the same reason (recycling would destroy the session history).

`make reload-check` is the regression test. The Console tab in the sidebar shows page errors
(`error`, uncaught exceptions, unhandled rejections) so a failure like this is visible instead
of looking like a hang.

## Speech, microphone, and sound

All three work, verified end to end by `make media-check`:

| Capability | Status in this app |
| --- | --- |
| `getUserMedia({audio:true})` | Works — returns the real input device |
| `webkitSpeechRecognition` | Works — `SpeechRecognition` (unprefixed) is undefined, use the prefix |
| `speechSynthesis` | Works — 68 system voices |
| WebAudio / `<audio>` autoplay | Works with no user gesture (`mediaTypesRequiringUserActionForPlayback = []`) |

**Two gates have to open, and they are easy to confuse.**

1. *The site gate.* `WKUIDelegate.requestMediaCapturePermissionFor` in `MediaPermissions.swift`.
   Without this delegate method, `getUserMedia` is denied outright. The app prompts once per
   origin per device with an `NSAlert` and remembers the answer until you navigate away.
   Web Speech goes through this same gate — verified on macOS 26, a speech request arrives as
   `mediaCapture:microphone`, so there is no separate speech permission hook to implement.
2. *The app gate.* macOS TCC, driven by `NSMicrophoneUsageDescription` and
   `NSSpeechRecognitionUsageDescription` in `Support/Info.plist`. **While TCC is undetermined,
   `getUserMedia` blocks before the site gate is ever reached** — it looks exactly like a hang,
   with no error and no delegate call. `make permissions` triggers those prompts deliberately;
   every `--selfcheck` report includes a `systemPermissions` block so you can tell the two
   apart.

Three things that will waste an afternoon otherwise:

- **Launch the app, do not run the binary.** macOS attributes a terminal-launched process's
  privacy requests to the *terminal*, so `./build/.../WebMCPBrowser` both inherits the
  terminal's grants and reports a misleading authorization status. Use `open`, `make run`, or
  Finder. Because an `open`-launched app has no usable stdout, `--selfcheck` and
  `--request-permissions` take `--out <file>`.
- **TCC caches the Info.plist per bundle ID.** If the app launched even once before a usage
  string existed, the next request hard-crashes with a `TCC` termination naming the key you
  just added. Purge the stale record: `tccutil reset All xyz.edfi.webmcpbrowser`, then
  `lsregister -f "build/WebMCP Browser.app"`.
- **Ad-hoc signing means the identity moves.** `make app` re-signs each build, so macOS may
  re-prompt after a rebuild. Sign with a stable identity if that gets annoying.

While a page is capturing, a red mic button appears in the toolbar; clicking it mutes the
capture through `setMicrophoneCaptureState` without telling the page. Site grants are session
only, never written to disk, and cleared on navigation.

## How the bridge works

`WKWebView` gives native code no live reference into the page's JS objects, so this is two
one-way channels stitched together.

**Page → Swift (discovery).** `Resources/webmcp-polyfill.js` is injected at
`.atDocumentStart`, into `WKContentWorld.page`, for every frame. It defines
`document.modelContext.registerTool`, which stores the tool in a page-side registry and posts a
JSON description to the `webmcpBridge` message handler. `WebMCPBridge` decodes it into
`WebMCPTool` and publishes it to SwiftUI.

**Swift → page (invocation).** A tool's `execute` callback can never cross the bridge, so
`WebMCPBridge.invoke` calls `window.__webmcpInvoke(name, argsJSON)` through
`callAsyncJavaScript`. Arguments and results travel as JSON *strings*, which keeps `undefined`,
`NaN`, and `Date` out of the `Any?` object bridge and lets Swift use `Codable`.

Four things this depends on and will break without:

- **Content world must be `.page`** for both the user script and the message handler. An
  isolated world would patch a `document.modelContext` the page's own scripts never see, and
  `window.webkit.messageHandlers` is per-world too.
- **Registrations are removed by `AbortSignal`**, not by name. The polyfill listens for
  `options.signal`'s abort and posts `unregistered`; sites that re-register on state changes
  would otherwise accumulate duplicates in the sidebar.
- **`execute(input, { signal })` takes two arguments**, per the current WebMCP draft.
- **The Swift-side list must be cleared on navigation.** `.atDocumentStart` re-injects the
  polyfill automatically, but nothing tells the app the old tool set is gone —
  `didStartProvisionalNavigation` calls `bridge.reset()`.

## Known simplifications

- `exposedTo` and the `tools` Permissions Policy are accepted and ignored: every frame that
  asks gets a `modelContext`. Correct for a local dev shell, wrong for a shipping browser.
- The page is trusted to describe its own tools; nothing validates a registration against the
  frame that sent it beyond recording that frame's origin.
- No tabs, no history UI, no bookmarks, no downloads.

## Layout

```
Package.swift                        executable target, macOS 14+, no dependencies
Sources/WebMCPBrowser/
  WebMCPBrowserApp.swift             @main App, one Window scene
  BrowserView.swift                  address bar, on/off pill, mic indicator, Tools/Console tabs
  BrowserModel.swift                 owns the WKWebView, address normalization, nav state
  WebView.swift                      NSViewRepresentable wrapper
  WebMCPBridge.swift                 both channels + @Published tool state
  WebMCPTool.swift                   Codable wire format and view model
  MediaPermissions.swift             site gate: capture permission + JS dialogs
  SystemPermissions.swift            app gate: TCC status and up-front requests
  SelfCheck.swift                    --selfcheck / --request-permissions headless reporting
  Resources/webmcp-polyfill.js       the whole JS side
  Resources/console-bridge.js        console + uncaught error capture
Support/Info.plist                   bundle identity, ATS for http://localhost, TCC usage strings
Tests/fixture.html                   registers 3 tools, aborts one after 3s
Tests/media.html                     tools that probe mic, speech, and audio output
Tests/no-tools.html                  negative control: registers nothing
Tests/polyfill.test.mjs              node contract test for the polyfill
Tests/media-check.sh                 drives Tests/media.html through the launched app
Tests/reload-check.sh                repeated-load regression test for the process leak
Makefile                             app / run / test / check / media-check / reload-check / permissions / clean
```
