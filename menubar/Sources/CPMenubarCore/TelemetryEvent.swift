import Foundation

public struct ToolActivity: Equatable, Sendable, Decodable {
    public let name: String
    public let target: String?

    public init(name: String, target: String? = nil) {
        self.name = name
        self.target = target
    }
}

public struct Progress: Equatable, Sendable, Decodable {
    public let phase: String
    public let taskKey: String?
    public let tool: ToolActivity?
    public let turns: Int?
    public let costUsd: Double?

    public init(
        phase: String,
        taskKey: String? = nil,
        tool: ToolActivity? = nil,
        turns: Int? = nil,
        costUsd: Double? = nil
    ) {
        self.phase = phase
        self.taskKey = taskKey
        self.tool = tool
        self.turns = turns
        self.costUsd = costUsd
    }
}

public struct Quota: Equatable, Sendable, Decodable {
    public let status: String
    public let utilization: Double?
    public let resetsAt: Double?
    public let rateLimitType: String?

    public init(
        status: String,
        utilization: Double? = nil,
        resetsAt: Double? = nil,
        rateLimitType: String? = nil
    ) {
        self.status = status
        self.utilization = utilization
        self.resetsAt = resetsAt
        self.rateLimitType = rateLimitType
    }
}

public struct Outcome: Equatable, Sendable, Decodable {
    public let outcome: String
    public let taskKey: String
    public let detail: String?

    public init(outcome: String, taskKey: String, detail: String? = nil) {
        self.outcome = outcome
        self.taskKey = taskKey
        self.detail = detail
    }
}

// Structurally discriminated, in the same order telemetry.ts does it: status means quota, outcome
// means outcome, otherwise progress. The wire carries no tag to key on.
public enum TelemetryEvent: Equatable, Sendable, Decodable {
    case progress(Progress)
    case quota(Quota)
    case outcome(Outcome)

    private enum Discriminator: String, CodingKey {
        case status, outcome, phase
    }

    public init(from decoder: any Decoder) throws {
        let keys = try decoder.container(keyedBy: Discriminator.self)
        if keys.contains(.status) {
            self = .quota(try Quota(from: decoder))
        } else if keys.contains(.outcome) {
            self = .outcome(try Outcome(from: decoder))
        } else if keys.contains(.phase) {
            self = .progress(try Progress(from: decoder))
        } else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "not a progress, quota or outcome update"))
        }
    }
}

public struct StatusResponse: Decodable, Sendable {
    public let paused: Bool
    public let current: Progress?
    public let recent: [Progress]

    public init(paused: Bool, current: Progress?, recent: [Progress]) {
        self.paused = paused
        self.current = current
        self.recent = recent
    }
}
