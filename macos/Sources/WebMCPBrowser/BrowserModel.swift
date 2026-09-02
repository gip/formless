import Combine
import Foundation
import WebKit

/// Owns the web view, the navigation state behind the address bar, and the WebMCP bridge.
@MainActor
final class BrowserModel: NSObject, ObservableObject {
    let bridge: WebMCPBridge
    /// Replaced by `recycleWebView()`, which is the only way to get a fresh web content
    /// process: WebKit reuses one process across same-origin reloads, so anything that leaks
    /// heap there (a WebContainer's WASM memory, for one) accumulates until the page OOMs.
    @Published private(set) var webView: WKWebView
    @Published private(set) var webViewGeneration = 0

    @Published var addressText: String = BrowserModel.startupAddress
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var lastError: String?
    private var observers: Set<AnyCancellable> = []
    /// Incremented when a new document commits, so tests can tell an old DOM from a new one.
    @Published private(set) var navigationGeneration = 0
    @Published private(set) var microphoneCapture: WKMediaCaptureState = .none
    @Published private(set) var cameraCapture: WKMediaCaptureState = .none

    /// Session-only site permissions, keyed by "origin|device". Never written to disk.
    var capturePermissions: [String: Bool] = [:]
    /// Which permission delegates WebKit actually called, in order. Surfaced by --selfcheck.
    private(set) var permissionLog: [String] = []

    func recordPermission(_ entry: String) {
        permissionLog.append(entry)
        FileHandle.standardError.write(Data("[permission] \(entry)\n".utf8))
    }

    override init() {
        let bridge = WebMCPBridge()
        self.bridge = bridge
        self.webView = BrowserModel.makeWebView(bridge: bridge)
        super.init()
        adopt(webView)
    }

    /// One configuration per web view: a fresh `WKWebViewConfiguration` also means a fresh
    /// process pool, and therefore a genuinely new web content process.
    private static func makeWebView(bridge: WebMCPBridge) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // Sound: let pages start audio and video without a click. WKWebView otherwise blocks
        // autoplay entirely, which also silences speech-synthesis and notification sounds.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsAirPlayForMediaPlayback = true
        // User scripts must be installed before the web view copies the configuration.
        bridge.attach(to: configuration)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        return webView
    }

    private func adopt(_ webView: WKWebView) {
        bridge.webView = webView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        observers = []
        webView.publisher(for: \.canGoBack).sink { [weak self] in self?.canGoBack = $0 }.store(in: &observers)
        webView.publisher(for: \.canGoForward).sink { [weak self] in self?.canGoForward = $0 }.store(in: &observers)
        webView.publisher(for: \.isLoading).sink { [weak self] in self?.isLoading = $0 }.store(in: &observers)
        webView.publisher(for: \.estimatedProgress).sink { [weak self] in self?.progress = $0 }.store(in: &observers)
        webView.publisher(for: \.microphoneCaptureState).sink { [weak self] in self?.microphoneCapture = $0 }.store(in: &observers)
        webView.publisher(for: \.cameraCaptureState).sink { [weak self] in self?.cameraCapture = $0 }.store(in: &observers)
    }

    /// Throws away the current web view (and its process) and loads `url` in a brand new one.
    func recycleWebView(loading url: URL?) {
        let target = url ?? webView.url
        let old = webView
        old.stopLoading()
        old.navigationDelegate = nil
        old.uiDelegate = nil

        bridge.reset()
        let fresh = BrowserModel.makeWebView(bridge: bridge)
        webView = fresh
        webViewGeneration += 1
        adopt(fresh)
        if let target { load(target) }
    }

    /// Generic start page: nothing loads unless the user (or `--url` / `WEBMCP_HOME`) asks.
    static var startupAddress: String {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--url"), index + 1 < arguments.count {
            return arguments[index + 1]
        }
        return ProcessInfo.processInfo.environment["WEBMCP_HOME"] ?? ""
    }

    /// Address-bar submit. Recycles the process: a same-process document load leaks whatever
    /// the previous document left on the heap, and pages that allocate a lot (a WebContainer
    /// host, say) stop booting after a handful of loads.
    func loadCurrentAddress() {
        guard let url = Self.normalize(addressText) else { return }
        recycleWebView(loading: url)
    }

    func load(_ url: URL) {
        lastError = nil
        addressText = url.absoluteString
        if url.isFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    /// Mute or unmute a live capture without the page knowing; `.none` stops it outright.
    func setMicrophoneCapture(_ state: WKMediaCaptureState) {
        webView.setMicrophoneCaptureState(state)
    }

    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }
    /// Reload in a fresh process — the default, because WebKit reuses one web content process
    /// across same-origin loads and a heap-hungry page degrades within a few reloads.
    func reload() { recycleWebView(loading: webView.url) }

    /// Ordinary in-process reload, kept for parity with other browsers (⇧⌘R) and because it
    /// preserves session storage and the back/forward list.
    func softReload() { webView.reload() }

    func hardReload() { reload() }

    /// `example.com` -> https, `localhost:3000` -> http, anything else word-like -> a search.
    nonisolated static func normalize(_ input: String) -> URL? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") || trimmed.hasPrefix("file://") {
            return URL(string: trimmed)
        }
        if trimmed.hasPrefix("/") || trimmed.hasPrefix("~/") {
            return URL(fileURLWithPath: (trimmed as NSString).expandingTildeInPath)
        }

        let isLocal = trimmed.hasPrefix("localhost") || trimmed.hasPrefix("127.0.0.1")
        let looksLikeHost = !trimmed.contains(" ") && (trimmed.contains(".") || isLocal)
        if looksLikeHost {
            return URL(string: "\(isLocal ? "http" : "https")://\(trimmed)")
        }

        var components = URLComponents(string: "https://duckduckgo.com/")
        components?.queryItems = [URLQueryItem(name: "q", value: trimmed)]
        return components?.url
    }
}

extension BrowserModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // A new main-frame document invalidates every tool the previous one registered.
        // The polyfill is re-injected automatically at .atDocumentStart; this side is not.
        bridge.reset()
        lastError = nil
        capturePermissions.removeAll()
        permissionLog.removeAll()
        if let url = webView.url { addressText = url.absoluteString }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        navigationGeneration += 1
        if let url = webView.url { addressText = url.absoluteString }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = webView.url { addressText = url.absoluteString }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        lastError = error.localizedDescription
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        lastError = error.localizedDescription
    }

    /// The web content process died (usually memory exhaustion). WKWebView renders blank from
    /// here on unless it is rebuilt, so recover automatically instead of showing a dead page.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        lastError = "The page ran out of memory. Reloaded it in a fresh process."
        recycleWebView(loading: webView.url)
    }
}
