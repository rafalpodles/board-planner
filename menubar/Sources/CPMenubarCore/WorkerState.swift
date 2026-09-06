import Foundation

public enum Health: Equatable, Sendable {
    case idle, working, needsHuman, disconnected, paused
}

public enum StepState: Equatable, Sendable {
    case done, active, pending
}

public struct StepRow: Equatable, Sendable {
    public let phase: String
    public let state: StepState
}

public struct WorkerState: Equatable, Sendable {
    public private(set) var health: Health = .idle
    public private(set) var currentPhase: String?
    public private(set) var currentTaskKey: String?
    public private(set) var recentTools: [ToolActivity] = []
    public private(set) var mergedToday: Int = 0
    public private(set) var lastQuota: Quota?
    public private(set) var lastEventAt: Date?
    private var phaseSince: Date?

    public init() {}

    public static let pipeline = ["claiming", "worktree", "agent", "gates", "push", "pr", "merge"]

    private static let recentToolLimit = 5

    public mutating func apply(_ event: TelemetryEvent, at now: Date) {
        lastEventAt = now
        switch event {
        case .progress(let progress):
            if health != .paused { health = .working }
            if currentPhase != progress.phase { phaseSince = now }
            currentPhase = progress.phase
            if let key = progress.taskKey { currentTaskKey = key }
            if let tool = progress.tool {
                recentTools.insert(tool, at: 0)
                if recentTools.count > Self.recentToolLimit { recentTools.removeLast() }
            }
        case .quota(let quota):
            lastQuota = quota
        case .outcome(let outcome):
            currentTaskKey = outcome.taskKey
            currentPhase = nil
            phaseSince = nil
            if outcome.outcome == "merged" { mergedToday += 1 }
            if outcome.outcome == "blocked" {
                health = .needsHuman
            } else if health != .paused {
                health = .idle
            }
        }
    }

    public mutating func adopt(_ status: StatusResponse, at now: Date) {
        lastEventAt = now
        currentPhase = status.current?.phase
        if let key = status.current?.taskKey { currentTaskKey = key }
        if status.current != nil, phaseSince == nil { phaseSince = now }
        health = status.paused ? .paused : (status.current == nil ? .idle : .working)
    }

    public mutating func markDisconnected() {
        health = .disconnected
        currentPhase = nil
        phaseSince = nil
    }

    public func iconName() -> String {
        switch health {
        case .idle: return "circle"
        case .working: return "circle.fill"
        case .paused: return "pause.circle"
        case .needsHuman: return "exclamationmark.circle.fill"
        case .disconnected: return "exclamationmark.triangle"
        }
    }

    public func title(now: Date) -> String? {
        guard let phase = currentPhase, let since = phaseSince else { return nil }
        let seconds = max(0, Int(now.timeIntervalSince(since)))
        let elapsed = "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
        guard let key = currentTaskKey else { return "\(phase) \(elapsed)" }
        return "\(key) · \(phase) \(elapsed)"
    }

    public func stepperRows() -> [StepRow] {
        let normalised = currentPhase.map { phase -> String in
            if phase.hasPrefix("gates:") { return "gates" }
            if phase.hasPrefix("step:") { return "agent" }
            return phase
        }
        guard let current = normalised, let index = Self.pipeline.firstIndex(of: current) else {
            return Self.pipeline.map { StepRow(phase: $0, state: .pending) }
        }
        return Self.pipeline.enumerated().map { offset, phase in
            StepRow(phase: phase, state: offset < index ? .done : (offset == index ? .active : .pending))
        }
    }
}

extension WorkerState {
    mutating func forceHealth(_ next: Health) {
        health = next
    }
}
