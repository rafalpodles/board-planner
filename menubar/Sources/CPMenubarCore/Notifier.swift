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
        case "gateRejected":
            return NotificationRequest(
                title: "\(outcome.taskKey) rejected by the \(outcome.detail ?? "unknown") gate",
                body: "The branch is still there; the task went back to the board.")
        case "blocked":
            return NotificationRequest(
                title: "\(outcome.taskKey) needs a human",
                body: outcome.detail ?? "The worker stopped and is waiting.")
        default:
            return nil
        }
    }
}

public final class Notifier: Sendable {
    public static let shared = Notifier()

    private init() {}

    public func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    public func handle(_ event: TelemetryEvent) {
        guard let request = notification(for: event) else { return }
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
