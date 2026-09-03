import Foundation

/// Headless verification of both bridge channels inside a real WKWebView:
///
///     WebMCPBrowser --selfcheck <url> [--invoke <tool> --args <json>] [--settle <seconds>]
///
/// Loads the page, waits for `document.modelContext` registrations, prints JSON, and exits
/// non-zero when no tools appear or an invocation fails. Used by `make check`.
enum SelfCheck {
    struct Options: Sendable {
        let url: URL
        let invoke: String?
        let argsJSON: String
        let settle: Double
    }

    static func argument(_ flag: String) -> String? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    /// TCC attributes a terminal-launched binary to the terminal, so any check that touches
    /// permissions has to run from an `open`-launched app — which has no stdout. `--out`
    /// writes the report to a file instead.
    static func emit(_ report: [String: Any], exitCode: Int32) -> Never {
        let data = (try? JSONSerialization.data(
            withJSONObject: report, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        if let path = argument("--out") {
            try? data.write(to: URL(fileURLWithPath: path))
        } else {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
        exit(exitCode)
    }

    static let options: Options? = {
        guard let raw = argument("--selfcheck"), let url = BrowserModel.normalize(raw) else { return nil }
        return Options(
            url: url,
            invoke: argument("--invoke"),
            argsJSON: argument("--args") ?? "{}",
            settle: Double(argument("--settle") ?? "") ?? 4.0)
    }()

    /// `--request-permissions` triggers the macOS microphone and speech prompts, then exits.
    static let requestsPermissions = CommandLine.arguments.contains("--request-permissions")

    @MainActor
    static func requestPermissionsAndExit() async {
        let before = SystemPermissions.report
        let after = await SystemPermissions.requestAll()
        emit(["before": before, "after": after], exitCode: after["microphone"] == "authorized" ? 0 : 1)
    }

    /// Polls the Formless Health phase label until the canvas is ready, the runtime errors out, or the
    /// budget expires. Returns seconds elapsed so slow and stuck are distinguishable.
    @MainActor
    static func measureReady(
        model: BrowserModel, budget: Double, label: String, awaitGeneration: Int
    ) async -> [String: Any] {
        let bridge = model.bridge
        let start = Date()
        // A reload is asynchronous: without this the first poll reads the previous document.
        while model.navigationGeneration < awaitGeneration, Date().timeIntervalSince(start) < budget {
            try? await Task.sleep(for: .milliseconds(50))
        }
        var phase = ""
        while Date().timeIntervalSince(start) < budget {
            let raw = await bridge.evaluate(
                """
                (document.querySelector('.preview-status')?.textContent ?? 'no status') + ' | ' +
                (document.querySelector('.runtime-detail')?.textContent ?? '')
                """)
            phase = ((try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any])?["value"]
                as? String ?? raw
            if phase.contains("Canvas ready") {
                return ["step": label, "ready": true, "seconds": Date().timeIntervalSince(start), "phase": phase]
            }
            if phase.contains("Runtime unavailable") {
                return ["step": label, "ready": false, "seconds": Date().timeIntervalSince(start), "phase": phase]
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return ["step": label, "ready": false, "seconds": budget, "phase": phase, "timedOut": true]
    }

    @MainActor
    static func run(model: BrowserModel, options: Options) async {
        model.load(options.url)

        // Wait for the first registration, then let late or aborted registrations settle.
        let deadline = Date().addingTimeInterval(20)
        while model.bridge.tools.isEmpty && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(200))
        }
        try? await Task.sleep(for: .seconds(options.settle))

        let bridge = model.bridge
        var report: [String: Any] = [
            "url": options.url.absoluteString,
            "polyfillReady": bridge.polyfillReady,
            "webmcp": bridge.isActive ? "on" : "off",
            "toolCount": bridge.tools.count,
            "systemPermissions": SystemPermissions.report,
            "tools": bridge.tools.map { tool in
                [
                    "name": tool.name,
                    "frame": tool.frameHost,
                    "mainFrame": tool.isMainFrame,
                    "readOnlyHint": tool.readOnlyHint as Any,
                ] as [String: Any]
            },
        ]
        if let error = model.lastError { report["navigationError"] = error }

        var failed = bridge.tools.isEmpty
        if let name = options.invoke {
            let result = await bridge.invoke(name: name, argsJSON: options.argsJSON)
            report["invoked"] = name
            report["invokeOK"] = result.ok
            report["invokeResult"] = result.text
            if !result.ok { failed = true }
        }

        // --reloads N with --ready-timeout measures time-to-ready across repeated loads,
        // which is what "hit refresh and it hangs" actually needs to distinguish: slow vs stuck.
        if let count = Int(argument("--reloads") ?? "") {
            let budget = Double(argument("--ready-timeout") ?? "") ?? 60
            var timings: [[String: Any]] = []
            timings.append(
                await measureReady(
                    model: model, budget: budget, label: "initial", awaitGeneration: 1))
            for index in 1...max(count, 1) {
                let next = model.navigationGeneration + 1
                if CommandLine.arguments.contains("--hard") {
                    model.hardReload()
                } else if CommandLine.arguments.contains("--renavigate") {
                    // Exactly what typing in the address bar and pressing Return does.
                    model.addressText = options.url.absoluteString
                    model.loadCurrentAddress()
                } else if CommandLine.arguments.contains("--soft") {
                    model.softReload()      // in-process reload, the known-degrading path
                } else {
                    model.reload()
                }
                timings.append(
                    await measureReady(
                        model: model, budget: budget, label: "reload \(index)",
                        awaitGeneration: next))
            }
            report["readyTimings"] = timings
        }
        if let expression = argument("--eval") {
            report["eval"] = await bridge.evaluate(expression)
        }
        if CommandLine.arguments.contains("--console") {
            report["console"] = bridge.consoleMessages.map { ["level": $0.level, "text": $0.text] }
        }
        // Read after the invocation: permission delegates fire during it, not before.
        report["permissionDelegateCalls"] = model.permissionLog
        emit(report, exitCode: failed ? 1 : 0)
    }
}
