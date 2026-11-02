import Foundation

public struct PanelSummary: Equatable, Sendable {
    public let headline: String
    public let detail: String
    public let pill: String
    public var caption: String? = nil
}

extension WorkerState {
    /// The three lines the panel opens with. Built from `effectiveHealth`, the same reading the icon
    /// takes, so the two channels cannot say different things about one machine (BP-616).
    public func panelSummary(now: Date, pollSeconds: Int?) -> PanelSummary {
        switch effectiveHealth(now: now) {
        case .idle:
            let detail = pollSeconds.map { "Checking the board every \(max(1, $0)) s." } ?? "Checking the board for approved tasks."
            let caption = agedOutFaultAge(now: now).map { "The last task couldn't run here · \(Self.ago($0))" }
            return PanelSummary(headline: "Waiting for work", detail: detail, pill: "Connected", caption: caption)
        case .working:
            let sentence = stageIndex.map { Self.stageSentences[$0] } ?? currentPhase.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "Working"
            let detail = elapsed(now: now).map { "\(sentence) · \(Self.clock($0))" } ?? sentence
            return PanelSummary(headline: currentTaskKey ?? "Working", detail: detail, pill: "Running")
        case .paused:
            // A pause stops new claims; a run already going carries on until it is stopped
            let detail = currentPhase != nil
                ? "\(currentTaskKey ?? "A task") is still running. Nothing new will start."
                : "Not claiming new tasks."
            return PanelSummary(headline: "Paused", detail: detail, pill: "Paused")
        case .needsHuman:
            let detail = currentTaskKey.map { "\($0) is waiting for you." } ?? "A task is waiting for you."
            return PanelSummary(headline: "Needs a human", detail: detail, pill: "Needs you")
        case .faulted:
            return PanelSummary(headline: machineFaultHeadline, detail: "The task went back to the queue.", pill: "Fault")
        case .disconnected:
            if let reason = disconnectReason {
                return PanelSummary(headline: "Won't connect", detail: reason, pill: "Offline")
            }
            return PanelSummary(headline: "Can't reach the worker", detail: "Retrying every few seconds.", pill: "Offline")
        }
    }

    static func ago(_ interval: TimeInterval) -> String {
        let minutes = Int(interval) / 60
        if minutes < 60 { return "\(minutes) min ago" }
        if minutes < 24 * 60 { return "\(minutes / 60) h ago" }
        return "\(minutes / (24 * 60)) d ago"
    }

    static func clock(_ interval: TimeInterval) -> String {
        let seconds = Int(interval)
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
}
