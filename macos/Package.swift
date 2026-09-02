// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WebMCPBrowser",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "WebMCPBrowser",
            resources: [
                .copy("Resources/webmcp-polyfill.js"),
                .copy("Resources/console-bridge.js"),
            ]
        )
    ]
)
