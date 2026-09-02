import AVFoundation
import Speech

/// macOS-level (TCC) authorization, which sits *underneath* the per-site permission in
/// `MediaPermissions`. WebKit consults this first: while microphone access is undetermined,
/// `getUserMedia` blocks on the system prompt and the `WKUIDelegate` is never called.
enum SystemPermissions {
    static var microphone: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    static var camera: String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    static var speechRecognition: String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    static var report: [String: String] {
        ["microphone": microphone, "speechRecognition": speechRecognition, "camera": camera]
    }

    /// Triggers the macOS prompts up front instead of mid-page, where a blocked `getUserMedia`
    /// looks like a hang. Safe to call repeatedly: an answered status never re-prompts.
    static func requestAll() async -> [String: String] {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        }
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { _ in continuation.resume() }
            }
        }
        return report
    }
}
