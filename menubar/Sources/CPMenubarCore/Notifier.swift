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
                title: machineFaultHeadline,
                // What happened first, the reason last. sandbox.ts:59 keeps the same rule and says
                // why: a banner is cut after a couple of lines, so whatever is at the end is what
                // nobody reads — and the reason here can be 200 characters of git's own stderr.
                //
                // "until the next poll", not "for this cycle": the loop ends one pass and sleeps,
                // so the claim withdraws itself in thirty seconds and says so. A sticky sentence
                // with no stated expiry is what BP-616 is about.
                body: "\(outcome.taskKey) went back to the queue and this machine will take no more work until the next poll. Reason: \(outcome.detail ?? "on the board.")")
        default:
            return nil
        }
    }
}

/**
 * Whether the last run already reported a machine fault.
 *
 * A machine fault recurs on every poll: the task is released with its attempt refunded, so the
 * loop claims it again a poll interval later — thirty seconds by default — and meets the same
 * broken machine. The worker keeps `ReleaseMemory` for exactly this on the board side
 * (worker/src/reporter.ts), and without the same thing here an overnight fault stacks one banner
 * every thirty seconds until morning. Six notifications only works if none of them repeats.
 *
 * A streak, not a key on the reason. Keying on the detail was the first attempt and it does not
 * survive the details this worker actually sends: the base-branch fault names the project's remote,
 * so a machine serving two projects alternates two reasons and every poll is "new" again, and
 * confine()'s refusal names the worktree path, which carries the task key. Both are per-run text
 * inside a 200-character cap.
 *
 * So the question is not "is this a new reason" but "have I already said this is failing". A
 * second, different fault while it is still failing is not re-announced — the operator has already
 * been told to go and look, and the run history keeps every reason. Cleared by an outcome that is
 * not a fault, which is the thing proving it can work; not by a run merely starting, because a
 * fault emits after a progress event on every recurrence.
 *
 * Per project, and that is not a refinement — a single flag is the same storm one step along. Two
 * of the four faults are a project's own (a remote nothing can reach, a checkout git will not
 * read), and `loop.ts`'s passOrder moves a faulting project to the END of the next pass precisely
 * so it cannot starve its siblings. So the healthy project's `merged` lands immediately before the
 * faulting one's fault, on every pass, by construction: a fleet-wide flag is cleared and re-armed
 * for ever, and the storm comes back at the cadence of the healthy project's runs.
 *
 * What scoping costs is that one machine-wide fault announces itself once per project. That is a
 * count, not a rate, which is the whole of the win — the alternative was never "one", it was one
 * per pass for ever. And a fault ends the pass, so N projects arrive as N notifications over N
 * polls rather than a burst. N stays small in practice: the two genuinely machine-wide faults are
 * the confinement refusals, and preflight's `claimBlocked` stops such a machine claiming anything
 * at all, so what reaches here machine-wide is a sandbox that broke after boot.
 *
 * Also cleared when the socket drops. Restarting the worker is what an operator does to fix a
 * machine, and it emits no outcome — so without this the first fault after the restart, which is
 * the moment they are most likely to be watching, would be the one they are not told about.
 */
public struct FaultStreak: Sendable {
    private var faulting: Set<String> = []

    public init() {}

    /// The worker went away. Whatever it does next is news again.
    public mutating func disconnected() {
        faulting.removeAll()
    }

    /// The project half of `WEB-API-12`, which is `WEB-API` and not `WEB`.
    ///
    /// From the LAST hyphen, because the half that cannot contain one is the number
    /// (`src/lib/task-key.ts`), while a project key may hold hyphens anywhere after its first
    /// character (`PROJECT_KEY_PATTERN`, `src/lib/urls.ts`). Splitting on the first collapsed
    /// `WEB-API` and `WEB-APP` into one bucket, which silenced one project's fault and let the
    /// other's healthy run re-arm it — the same storm this scoping exists to stop, one family
    /// narrower (found in review). A key with no hyphen at all is the `#42` shape a task whose
    /// project cannot be resolved gets, and it buckets as itself.
    private static func project(of taskKey: String) -> String {
        guard let cut = taskKey.lastIndex(of: "-") else { return taskKey }
        return String(taskKey[..<cut])
    }

    /// The notification this event deserves, or nil — including nil for a fault already reported.
    public mutating func admit(_ event: TelemetryEvent) -> NotificationRequest? {
        guard case .outcome(let outcome) = event else { return notification(for: event) }
        let project = Self.project(of: outcome.taskKey)
        guard outcome.outcome == "machineFault" else {
            faulting.remove(project)
            return notification(for: event)
        }
        return faulting.insert(project).inserted ? notification(for: event) : nil
    }
}

public final class Notifier: Sendable {
    public static let shared = Notifier()

    // MainActor-isolated because AppModel's pump is, and this is the only caller.
    @MainActor private static var faults = FaultStreak()

    private init() {}

    public func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Named for the event rather than its effect, and to match `state.markDisconnected()` beside
    /// it at the call site: it clears the fault streak and nothing else.
    @MainActor
    public func workerDisconnected() {
        Notifier.faults.disconnected()
    }

    /// What this event would raise, dedupe applied — the whole decision, on the object the app
    /// holds, so a test can drive it without a signed bundle.
    ///
    /// What stays uncovered is `handle`'s delivery below: nothing checks that `title` and `body`
    /// reach `content.title` and `content.body` rather than each other's. Swapped, the banner shows
    /// two hundred characters of git's stderr as its heading and every test here still passes. It
    /// ends at UNUserNotificationCenter, which needs a signed bundle and a running app.
    @MainActor
    public func request(for event: TelemetryEvent) -> NotificationRequest? {
        Notifier.faults.admit(event)
    }

    @MainActor
    public func handle(_ event: TelemetryEvent) {
        guard let request = request(for: event) else { return }
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
