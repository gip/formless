import SwiftUI

@main
struct WebMCPBrowserApp: App {
    @StateObject private var model = BrowserModel()

    var body: some Scene {
        Window("WebMCP Browser", id: "browser") {
            BrowserView(model: model)
        }
        .defaultSize(width: 1320, height: 860)
        .commands {
            CommandGroup(after: .sidebar) {
                Button("Reload") { model.reload() }
                    .keyboardShortcut("r")
                Button("Reload in Same Process") { model.softReload() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                Divider()
            }
        }
    }
}
