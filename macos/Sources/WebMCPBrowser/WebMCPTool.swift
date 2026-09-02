import Foundation

/// One tool the loaded page registered on `document.modelContext`.
struct WebMCPTool: Identifiable, Hashable {
    let name: String
    let title: String?
    let toolDescription: String
    let inputSchemaJSON: String?
    let annotationsJSON: String?
    let readOnlyHint: Bool?
    let untrustedContentHint: Bool?
    let frameHost: String
    let isMainFrame: Bool

    /// Registrations are per frame, so the same name can legitimately appear in a subframe.
    var id: String { "\(frameHost)#\(name)" }

    var displayTitle: String { title?.isEmpty == false ? title! : name }

    var prettyInputSchema: String {
        guard let inputSchemaJSON else { return "No input schema." }
        return WebMCPTool.prettyPrint(inputSchemaJSON) ?? inputSchemaJSON
    }

    static func prettyPrint(_ json: String) -> String? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                  withJSONObject: object,
                  options: [.prettyPrinted, .sortedKeys])
        else { return nil }
        return String(data: pretty, encoding: .utf8)
    }
}

/// The wire format posted by `webmcp-polyfill.js`.
struct BridgeEnvelope: Decodable {
    struct ToolPayload: Decodable {
        let name: String
        let title: String?
        let description: String
        let inputSchemaJSON: String?
        let annotationsJSON: String?
        let readOnlyHint: Bool?
        let untrustedContentHint: Bool?
    }

    let type: String
    let tool: ToolPayload?
    let name: String?
}

extension WebMCPTool {
    init(payload: BridgeEnvelope.ToolPayload, frameHost: String, isMainFrame: Bool) {
        self.name = payload.name
        self.title = payload.title
        self.toolDescription = payload.description
        self.inputSchemaJSON = payload.inputSchemaJSON
        self.annotationsJSON = payload.annotationsJSON
        self.readOnlyHint = payload.readOnlyHint
        self.untrustedContentHint = payload.untrustedContentHint
        self.frameHost = frameHost
        self.isMainFrame = isMainFrame
    }
}

struct ConsoleEnvelope: Decodable {
    let level: String
    let text: String
}
