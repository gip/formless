import Foundation
import WebKit

/// Both halves of the native <-> page bridge.
///
/// Channel 1 (page -> Swift): `webmcp-polyfill.js` posts a JSON string to the `webmcpBridge`
/// message handler every time the page registers or drops a tool.
/// Channel 2 (Swift -> page): `invoke` calls `window.__webmcpInvoke` by name, because
/// `message.body` can never carry a live JS function reference across the bridge.
@MainActor
final class WebMCPBridge: ObservableObject {
    static let handlerName = "webmcpBridge"
    static let consoleHandlerName = "consoleBridge"

    struct ConsoleEntry: Identifiable {
        let id = UUID()
        let level: String
        let text: String
        let frameHost: String
    }

    @Published private(set) var tools: [WebMCPTool] = []
    @Published private(set) var polyfillReady = false
    /// Capped so a page in a console-logging loop cannot grow this without bound.
    @Published private(set) var consoleMessages: [ConsoleEntry] = []

    weak var webView: WKWebView?

    var isActive: Bool { !tools.isEmpty }

    /// The polyfill and the message handler must both live in `WKContentWorld.page`: an
    /// isolated world would patch a different `document.modelContext` than the page sees, and
    /// `window.webkit.messageHandlers` is per-world too.
    func attach(to configuration: WKWebViewConfiguration) {
        let controller = configuration.userContentController
        let script = WKUserScript(
            source: Self.polyfillSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .page)
        controller.addUserScript(script)
        controller.addUserScript(WKUserScript(
            source: Self.consoleSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .page))
        // WKUserContentController retains handlers strongly; the relay holds the bridge weakly.
        let relay = ScriptMessageRelay(bridge: self)
        controller.add(relay, contentWorld: .page, name: Self.handlerName)
        controller.add(relay, contentWorld: .page, name: Self.consoleHandlerName)
    }

    /// A new document means the old tool set is gone, and nothing tells us that but this.
    func reset() {
        tools = []
        polyfillReady = false
        consoleMessages = []
    }

    func handleConsole(raw: String, originHost: String) {
        guard let data = raw.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(ConsoleEnvelope.self, from: data)
        else { return }
        consoleMessages.append(
            ConsoleEntry(level: envelope.level, text: envelope.text, frameHost: originHost))
        if consoleMessages.count > 500 { consoleMessages.removeFirst(consoleMessages.count - 500) }
    }

    func handle(raw: String, isMainFrame: Bool, originHost: String) {
        guard let data = raw.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(BridgeEnvelope.self, from: data)
        else { return }

        switch envelope.type {
        case "ready":
            if isMainFrame { polyfillReady = true }
        case "registered":
            guard let payload = envelope.tool else { return }
            let tool = WebMCPTool(payload: payload, frameHost: originHost, isMainFrame: isMainFrame)
            tools.removeAll { $0.id == tool.id }
            tools.append(tool)
        case "unregistered":
            guard let name = envelope.name else { return }
            tools.removeAll { $0.name == name && $0.frameHost == originHost }
        default:
            break
        }
    }

    struct InvocationResult {
        let ok: Bool
        let text: String
    }

    func invoke(name: String, argsJSON: String) async -> InvocationResult {
        guard let webView else {
            return InvocationResult(ok: false, text: "No web view is attached.")
        }
        // Arguments go through `arguments:`, never string interpolation: a quote or backslash
        // in a tool argument would otherwise break the function body.
        let body = "return await window.__webmcpInvoke(name, argsJSON);"
        do {
            let value = try await webView.callAsyncJavaScript(
                body,
                arguments: ["name": name, "argsJSON": argsJSON],
                in: nil,
                contentWorld: .page)
            guard let json = value as? String else {
                return InvocationResult(ok: false, text: "The page returned no result.")
            }
            let ok = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])??["ok"] as? Bool
            return InvocationResult(ok: ok ?? false, text: WebMCPTool.prettyPrint(json) ?? json)
        } catch {
            return InvocationResult(ok: false, text: "Invocation failed: \(error.localizedDescription)")
        }
    }

    /// Evaluates an expression in the page world. Diagnostics only; the result is JSON so it
    /// survives the object bridge.
    func evaluate(_ expression: String) async -> String {
        guard let webView else { return "{\"ok\":false,\"error\":\"No web view\"}" }
        let body = """
            try {
                const value = await eval(js);
                return JSON.stringify({ ok: true, value: value ?? null });
            } catch (error) {
                return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
            }
            """
        do {
            let value = try await webView.callAsyncJavaScript(
                body, arguments: ["js": expression], in: nil, contentWorld: .page)
            return value as? String ?? "null"
        } catch {
            return "{\"ok\":false,\"error\":\"\(error.localizedDescription)\"}"
        }
    }

    static let consoleSource: String = source(named: "console-bridge")

    static let polyfillSource: String = source(named: "webmcp-polyfill")

    private static func source(named name: String) -> String {
        guard let url = Bundle.module.url(forResource: name, withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8)
        else {
            fatalError(
                "\(name).js is missing from the app bundle. Rebuild with `make app` so the "
                    + "SwiftPM resource bundle is copied into Contents/Resources.")
        }
        return source
    }

}

/// Keeps `WKUserContentController`'s strong hold off the bridge (and therefore off the web view).
private final class ScriptMessageRelay: NSObject, WKScriptMessageHandler {
    private weak var bridge: WebMCPBridge?

    init(bridge: WebMCPBridge) {
        self.bridge = bridge
    }

    // WKScriptMessage is main-actor isolated in the SDK, so the callback is too.
    @MainActor
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let raw = message.body as? String ?? ""
        let frame = message.frameInfo
        let host = frame.securityOrigin.host
        let origin = host.isEmpty ? (frame.request.url?.host ?? "page") : host
        if message.name == WebMCPBridge.consoleHandlerName {
            bridge?.handleConsole(raw: raw, originHost: origin)
        } else {
            bridge?.handle(raw: raw, isMainFrame: frame.isMainFrame, originHost: origin)
        }
    }
}
