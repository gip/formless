import SwiftUI
import WebKit

struct BrowserView: View {
    @ObservedObject var model: BrowserModel

    var body: some View {
        VStack(spacing: 0) {
            AddressBar(model: model, bridge: model.bridge)
            Divider()
            if model.isLoading {
                ProgressView(value: model.progress)
                    .progressViewStyle(.linear)
                    .frame(height: 2)
            }
            HSplitView {
                ZStack(alignment: .top) {
                    WebView(webView: model.webView)
                        .id(model.webViewGeneration)
                        .frame(minWidth: 480)
                    if let error = model.lastError {
                        Text(error)
                            .font(.callout)
                            .padding(8)
                            .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 6))
                            .foregroundStyle(.white)
                            .padding(12)
                    }
                }
                InspectorView(bridge: model.bridge)
                    .frame(minWidth: 300, idealWidth: 340, maxWidth: 520)
            }
        }
        .onAppear {
            if SelfCheck.requestsPermissions {
                Task { await SelfCheck.requestPermissionsAndExit() }
            } else if let options = SelfCheck.options {
                Task { await SelfCheck.run(model: model, options: options) }
            } else {
                model.loadCurrentAddress()
            }
        }
    }
}

private struct AddressBar: View {
    @ObservedObject var model: BrowserModel
    @ObservedObject var bridge: WebMCPBridge

    var body: some View {
        HStack(spacing: 8) {
            Button(action: model.goBack) { Image(systemName: "chevron.left") }
                .disabled(!model.canGoBack)
            Button(action: model.goForward) { Image(systemName: "chevron.right") }
                .disabled(!model.canGoForward)
            Button(action: model.reload) { Image(systemName: "arrow.clockwise") }

            TextField("Enter a URL or a search", text: $model.addressText)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 13))
                .onSubmit { model.loadCurrentAddress() }

            if model.microphoneCapture != .none {
                Button {
                    model.setMicrophoneCapture(model.microphoneCapture == .active ? .muted : .active)
                } label: {
                    Image(systemName: model.microphoneCapture == .active ? "mic.fill" : "mic.slash.fill")
                        .foregroundStyle(model.microphoneCapture == .active ? Color.red : Color.secondary)
                }
                .help(model.microphoneCapture == .active
                    ? "This page is using the microphone. Click to mute it."
                    : "Microphone muted for this page. Click to unmute.")
            }

            StatusPill(isActive: bridge.isActive, count: bridge.tools.count)
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

private struct StatusPill: View {
    let isActive: Bool
    let count: Int

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(isActive ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 8, height: 8)
            Text(isActive ? "WebMCP · \(count)" : "WebMCP off")
                .font(.system(size: 12, weight: .medium))
                .monospacedDigit()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            Capsule().fill(isActive ? Color.green.opacity(0.15) : Color.secondary.opacity(0.12)))
        .help(isActive
            ? "The page registered \(count) tool(s) on document.modelContext."
            : "The page has not registered any WebMCP tools.")
    }
}

private struct InspectorView: View {
    @ObservedObject var bridge: WebMCPBridge

    private enum Tab: String, CaseIterable { case tools = "Tools", console = "Console" }

    @State private var tab: Tab = .tools
    @State private var selectedTool: String = ""
    @State private var argumentsText: String = "{}"
    @State private var resultText: String = "Run a tool to inspect its response."
    @State private var resultOK: Bool?
    @State private var isRunning = false

    private var toolNames: [String] { bridge.tools.map(\.name) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { choice in
                    Text(choice == .console && !errors.isEmpty
                        ? "\(choice.rawValue) (\(errors.count))"
                        : choice.rawValue)
                        .tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            Divider()

            switch tab {
            case .tools:
                if bridge.tools.isEmpty {
                    emptyState
                } else {
                    List(bridge.tools) { tool in
                        ToolRow(tool: tool)
                    }
                    .listStyle(.inset)
                }
                Divider()
                console
            case .console:
                consolePane
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .onChange(of: toolNames) { _, names in
            if !names.contains(selectedTool) { selectedTool = names.first ?? "" }
        }
        .onChange(of: errors.count) { _, count in
            // Surface a page that just broke without hiding the tool list behind a click.
            if count > 0, tab == .tools, bridge.tools.isEmpty { tab = .console }
        }
    }

    private var errors: [WebMCPBridge.ConsoleEntry] {
        bridge.consoleMessages.filter { ["error", "uncaught", "rejection"].contains($0.level) }
    }

    private var consolePane: some View {
        Group {
            if bridge.consoleMessages.isEmpty {
                Text("Nothing logged by this page yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(bridge.consoleMessages) { entry in
                            HStack(alignment: .top, spacing: 6) {
                                Text(entry.level)
                                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(color(for: entry.level))
                                    .frame(width: 58, alignment: .leading)
                                Text(entry.text)
                                    .font(.system(size: 11, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(12)
                }
            }
        }
    }

    private func color(for level: String) -> Color {
        switch level {
        case "error", "uncaught", "rejection": return .red
        case "warn": return .orange
        default: return .secondary
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("WebMCP")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(bridge.isActive
                ? "\(bridge.tools.count) tool\(bridge.tools.count == 1 ? "" : "s") registered"
                : "No tools registered")
                .font(.system(size: 15, weight: .semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(bridge.polyfillReady
                ? "document.modelContext is available to this page, but nothing has registered a tool."
                : "Waiting for a page to load.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var console: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tool console")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            Picker("Tool", selection: $selectedTool) {
                if toolNames.isEmpty { Text("No tools").tag("") }
                ForEach(toolNames, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .disabled(toolNames.isEmpty)

            TextEditor(text: $argumentsText)
                .font(.system(size: 12, design: .monospaced))
                .frame(height: 66)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(.separator))

            HStack {
                Button(isRunning ? "Running…" : "Run tool") { run() }
                    .disabled(isRunning || selectedTool.isEmpty)
                Spacer()
                if let resultOK {
                    Circle()
                        .fill(resultOK ? Color.green : Color.red)
                        .frame(width: 8, height: 8)
                }
            }

            ScrollView {
                Text(resultText)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 150)
        }
        .padding(12)
    }

    private func run() {
        isRunning = true
        resultOK = nil
        let name = selectedTool
        let args = argumentsText.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let result = await bridge.invoke(name: name, argsJSON: args.isEmpty ? "{}" : args)
            resultText = result.text
            resultOK = result.ok
            isRunning = false
        }
    }
}

private struct ToolRow: View {
    let tool: WebMCPTool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(tool.name)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                if tool.readOnlyHint == true { Badge(text: "read-only") }
                if tool.untrustedContentHint == true { Badge(text: "untrusted") }
                if !tool.isMainFrame { Badge(text: tool.frameHost) }
            }
            Text(tool.toolDescription)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
        .padding(.vertical, 3)
        .help(tool.prettyInputSchema)
    }
}

private struct Badge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(.secondary.opacity(0.15)))
            .foregroundStyle(.secondary)
    }
}
