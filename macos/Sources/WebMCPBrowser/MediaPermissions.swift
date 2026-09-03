import AppKit
import WebKit

/// Site permissions for capture devices, plus the audio playback policy.
///
/// Two independent gates have to open before a page can hear anything:
///   1. **The site gate** — `WKUIDelegate.requestMediaCapturePermissionFor`. Without this
///      delegate method `getUserMedia` is denied outright; this is the "example.com wants to
///      use your microphone" decision, remembered per origin for the session.
///   2. **The app gate** — macOS TCC, driven by `NSMicrophoneUsageDescription` and
///      `NSSpeechRecognitionUsageDescription` in Info.plist. macOS shows that prompt itself
///      the first time capture actually starts, and terminates the app if the key is missing.
///      While TCC is undetermined, `getUserMedia` blocks *before* reaching this delegate, which
///      looks exactly like a hang — see `SystemPermissions` and `--request-permissions`.
extension BrowserModel: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void
    ) {
        let device: String
        switch type {
        case .camera: device = "camera"
        case .microphone: device = "microphone"
        case .cameraAndMicrophone: device = "camera and microphone"
        @unknown default: device = "camera or microphone"
        }
        let site = origin.host.isEmpty ? "This page" : origin.host
        let key = "\(origin.protocol)://\(origin.host)|\(device)"
        recordPermission("mediaCapture:\(device) origin=\(key)")

        if let remembered = capturePermissions[key] {
            decisionHandler(remembered ? .grant : .deny)
            return
        }
        // A modal prompt would hang the headless bridge check, so --selfcheck auto-grants.
        if SelfCheck.options != nil {
            capturePermissions[key] = true
            decisionHandler(.grant)
            return
        }

        let alert = NSAlert()
        alert.messageText = "Allow \(site) to use the \(device)?"
        alert.informativeText =
            "This choice is remembered until you quit. macOS may also ask for its own permission."
        alert.addButton(withTitle: "Allow")
        alert.addButton(withTitle: "Don't Allow")
        let granted = alert.runModal() == .alertFirstButtonReturn
        capturePermissions[key] = granted
        decisionHandler(granted ? .grant : .deny)
    }

    // Web Speech: verified on macOS 26 that `webkitSpeechRecognition` routes through the
    // media-capture delegate above (it reports `mediaCapture:microphone`), so there is no
    // separate speech permission hook to implement. The app still needs
    // NSSpeechRecognitionUsageDescription, because the Speech framework checks TCC underneath.

    /// Pages call `alert()` / `confirm()` for real reasons (Formless Health's reset flow, for one), and
    /// WKWebView silently drops them unless the UI delegate renders them.
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor () -> Void
    ) {
        guard SelfCheck.options == nil else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (Bool) -> Void
    ) {
        guard SelfCheck.options == nil else { completionHandler(false); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}
