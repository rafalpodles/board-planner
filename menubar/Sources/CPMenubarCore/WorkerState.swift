import Foundation

/**
 * What a machine fault is called, wherever it is said.
 *
 * One constant because the panel and the notification are one sentence about one state, and as two
 * literals they had already drifted apart once inside a single review — the notification was
 * reworded and the panel was not. Past tense on purpose: the worker stops claiming for one pass,
 * several of these faults are transients, and a present-tense claim about the machine is one
 * nothing here can withdraw.
 */
public let machineFaultHeadline = "This machine couldn't run the last task"

public enum Health: Equatable, Sendable, CaseIterable {
    // faulted says the last run could not run on this machine at all — not that the task was
    // rejected, and not that the machine is latched off: the worker stops claiming for one pass
    // and tries again a poll interval later (worker/src/loop.ts). Its own case rather than
    // needsHuman so the switches below have to say what it looks like (BP-609).
    case idle, working, needsHuman, faulted, disconnected, paused
}

public struct WorkerState: Equatable, Sendable {
    public private(set) var health: Health = .idle
    public private(set) var currentPhase: String?
    public private(set) var currentTaskKey: String?
    public private(set) var recentTools: [ToolActivity] = []
    public private(set) var mergedToday: Int = 0
    public private(set) var lastQuota: Quota?
    public private(set) var lastOutcome: Outcome?
    public private(set) var lastEventAt: Date?
    private var phaseSince: Date?
    /// When this machine last said it could not run a task. See `effectiveHealth(now:)`.
    private var faultedAt: Date?

    public init() {}

    public static let pipeline = ["claiming", "worktree", "agent", "gates", "push", "pr", "merge"]

    private static let recentToolLimit = 5

    public mutating func apply(_ event: TelemetryEvent, at now: Date) {
        lastEventAt = now
        switch event {
        case .progress(let progress):
            if health != .paused { health = .working }
            if currentPhase != progress.phase { phaseSince = now }
            // The first event of a run starts from nothing: claiming carries no key, and the last
            // task's would otherwise head a panel about a task that is not this one
            if currentPhase == nil { currentTaskKey = nil }
            currentPhase = progress.phase
            if let key = progress.taskKey { currentTaskKey = key }
            if let tool = progress.tool {
                recentTools.insert(tool, at: 0)
                if recentTools.count > Self.recentToolLimit { recentTools.removeLast() }
            }
        case .quota(let quota):
            lastQuota = quota
        case .outcome(let outcome):
            lastOutcome = outcome
            currentTaskKey = outcome.taskKey
            currentPhase = nil
            phaseSince = nil
            if outcome.outcome == "merged" { mergedToday += 1 }
            if outcome.outcome == "blocked" {
                // Behind the same pause guard as the two branches below. The loop claims nothing
                // while paused, so an outcome arriving during a pause is the tail of a run that
                // started before it — and dropping .paused turns the panel's Resume button back
                // into Pause, on a worker that is already paused (BP-612).
                if health != .paused { health = .needsHuman }
            } else if outcome.outcome == "machineFault" {
                // Not .idle, which is what a released run leaves and what a machine with nothing to
                // do looks like — the last run here could not run at all.
                //
                // Sticky, and the panel's wording is past tense because of it: nothing emits while
                // the queue is empty, so a fault on the last task of the night is still on screen
                // in the morning. It clears on the next run's first progress event, on a
                // reconnect's status, or on the next outcome.
                //
                // Behind the pause guard, unlike the blocked branch above: the loop claims nothing
                // while paused, so a fault can only be the tail of a run that started before the
                // pause, and overwriting .paused turns the panel's Resume button back into Pause.
                if health != .paused {
                    health = .faulted
                    faultedAt = now
                }
            } else if health != .paused {
                health = .idle
            }
        }
    }

    public mutating func adopt(_ status: StatusResponse, at now: Date) {
        lastEventAt = now
        faultedAt = nil
        currentPhase = status.current?.phase
        if let key = status.current?.taskKey { currentTaskKey = key }
        if status.current != nil, phaseSince == nil { phaseSince = now }
        health = status.paused ? .paused : (status.current == nil ? .idle : .working)
    }

    // Why the app will not talk to the socket at all, when that is the reason it is disconnected
    public private(set) var disconnectReason: String?

    public mutating func markDisconnected(reason: String? = nil) {
        disconnectReason = reason
        health = .disconnected
        currentPhase = nil
        phaseSince = nil
        faultedAt = nil
    }

    /**
     * How long a machine fault keeps saying so while nothing else happens.
     *
     * `faulted` is sticky, and on an idle machine nothing ever clears it: progress is emitted only
     * from inside a run, `adopt` runs once per socket connection, and a pass that claims nothing
     * emits nothing at all. So a transient blip at 02:00 left the wrench icon on screen at 09:00,
     * on a machine that had been healthy for seven hours — and the icon, unlike the panel's
     * headline, cannot be put in the past tense (BP-616).
     *
     * Fifteen minutes, in the menubar, rather than an idle telemetry tick from the worker. The tick
     * is the truthful fix and is worth doing on its own; this is the half that stops the icon
     * lying, and it is well clear of the default thirty-second poll — a machine that is still
     * faulting re-stamps this on every pass and keeps the icon, which is the case that matters.
     */
    public static let faultGrace: TimeInterval = 15 * 60

    /**
     * The health the panel shows, which is what `health` says except for a fault nothing has
     * repeated for `faultGrace`.
     *
     * Read by both the icon and the headline, so the two cannot disagree about a machine — they
     * are one claim in two channels, and only one of them can be phrased in the past tense.
     */
    public func effectiveHealth(now: Date) -> Health {
        guard health == .faulted, let since = faultedAt else { return health }
        return now.timeIntervalSince(since) >= Self.faultGrace ? .idle : .faulted
    }

    public func title(now: Date) -> String? {
        guard let phase = currentPhase, let since = phaseSince else { return nil }
        let seconds = max(0, Int(now.timeIntervalSince(since)))
        let elapsed = "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
        guard let key = currentTaskKey else { return "\(phase) \(elapsed)" }
        return "\(key) · \(phase) \(elapsed)"
    }

    /// Where the current run is in `pipeline`, with every composed block folded onto the stage it
    /// belongs to: the pipeline's gate count is project policy, not a fixed shape.
    public var stageIndex: Int? {
        guard let phase = currentPhase else { return nil }
        let stage: String
        if phase.hasPrefix("gates:") {
            stage = "gates"
        } else if phase.hasPrefix("step:") {
            stage = "agent"
        } else {
            stage = phase
        }
        return Self.pipeline.firstIndex(of: stage)
    }

    public static let stageLabels = ["Claim", "Worktree", "Agent", "Gates", "Push", "PR", "Merge"]

    static let stageSentences = [
        "Claiming the task", "Preparing a worktree", "The agent is working", "Running the checks",
        "Pushing the branch", "Opening the pull request", "Merging the pull request",
    ]

    public func elapsed(now: Date) -> TimeInterval? {
        phaseSince.map { max(0, now.timeIntervalSince($0)) }
    }
}

extension WorkerState {
    // Test seam: every other route into a Health goes through an event, and no event produces
    // disconnected and paused from the same starting point.
    mutating func forceHealth(_ next: Health) {
        health = next
    }
}
