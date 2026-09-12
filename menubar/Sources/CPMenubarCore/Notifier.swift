import Foundation
import UserNotifications

public struct NotificationRequest: Equatable, Sendable {
    public let title: String
    public let body: String
}

// Split from delivery so the decision is testable: UNUserNotificationCenter needs a signed bundle
// and a running app, and none of that is what could be wrong here.
public func notification(for event: TelemetryEvent) -> NotificationRequest? {
    switch event {
    case .progress:
        return nil

    case .quota(let quota):
        guard quota.status == "rejected" else { return nil }
        return NotificationRequest(
            title: "Usage limit reached",
            body: "The worker released its task and will pick it up again later.")

    case .outcome(let outcome):
        switch outcome.outcome {
        case "merged":
            return NotificationRequest(
                title: "\(outcome.taskKey) merged",
                body: "The worker is free again.")
        // With autoMerge off this replaces "merged" as the end of a successful run, so without it
        // the operator would get no notification at all for work that went well.
        case "delivered":
            return NotificationRequest(
                title: "\(outcome.taskKey) is ready for review",
                body: outcome.detail ?? "A pull request is open; the worker did not merge it.")
        case "gateRejected":
            return NotificationRequest(
                title: "\(outcome.taskKey) rejected by the \(outcome.detail ?? "unknown") gate",
                body: "The branch is still there; the task went back to the board.")
        case "blocked":
            return NotificationRequest(
                title: "\(outcome.taskKey) needs a human",
                body: outcome.detail ?? "The worker stopped and is waiting.")
        // The one outcome that is about the machine rather than the task, and the only way an
        // operator learns of it: the task went quietly back to the queue with its attempt
        // refunded, so nothing on the board asks for them (BP-609).
        // Past tense, and deliberately: the loop stops claiming for one pass, not until somebody
        // fixes anything (worker/src/loop.ts), and several of the faults that reach here are
        // transients. A present-tense claim about the machine is one this app has no channel to
        // withdraw.
        case "machineFault":
            return NotificationRequest(
                title: "This machine couldn't run the work",
                body: "\(outcome.taskKey) went back to the queue: \(outcome.detail ?? "the reason is on the board"). Claiming has stopped for this cycle.")
        default:
            return nil
        }
    }
}

/**
 * The fault the last notification reported.
 *
 * A machine fault recurs on every poll: the task is released with its attempt refunded, so the
 * loop claims it again a poll interval later — thirty seconds by default — and meets the same
 * broken machine. The worker keeps `ReleaseMemory` for exactly this on the board side
 * (worker/src/reporter.ts), and without the same thing here an overnight fault stacks one banner
 * every thirty seconds until morning. Five notifications only works if none of them repeats.
 *
 * Keyed on the reason rather than the task, because the subject is the machine: the same fault met
 * by a different task is the same news. Kept until a run ends some other way — not until the next
 * run starts, because a run starting is not a machine working; a fault emits after a progress
 * event on every recurrence.
 */
public struct FaultMemory: Sendable {
    private var last: String?

    public init() {}

    /// The notification this event deserves, or nil — including nil for a fault already reported.
    public mutating func admit(_ event: TelemetryEvent) -> NotificationRequest? {
        guard case .outcome(let outcome) = event else { return notification(for: event) }
        guard outcome.outcome == "machineFault" else {
            last = nil
            return notification(for: event)
        }
        let reason = outcome.detail ?? ""
        let repeated = last == reason
        last = reason
        return repeated ? nil : notification(for: event)
    }
}

public final class Notifier: Sendable {
    public static let shared = Notifier()

    // MainActor-isolated because AppModel's pump is, and this is the only caller.
    @MainActor private static var faults = FaultMemory()

    private init() {}

    public func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    @MainActor
    public func handle(_ event: TelemetryEvent) {
        guard let request = Notifier.faults.admit(event) else { return }
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
