import SwiftUI
import WebKit

/// Hosts the model's single long-lived `WKWebView`; SwiftUI never recreates it.
struct WebView: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView { webView }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
