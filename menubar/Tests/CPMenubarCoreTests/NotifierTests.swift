import Foundation
import Testing
@testable import CPMenubarCore

@Test func notifiesOnAMerge() {
    let request = notification(for: .outcome(Outcome(outcome: "merged", taskKey: "CP-1")))

    #expect(request?.title == "CP-1 merged")
}

@Test func notifiesOnAGateRejectionAndNamesTheGate() {
    let request = notification(
        for: .outcome(Outcome(outcome: "gateRejected", taskKey: "CP-1", detail: "build")))

    #expect(request?.title == "CP-1 rejected by the build gate")
}

@Test func namesTheGateAsUnknownRatherThanDroppingTheNotification() {
    let request = notification(for: .outcome(Outcome(outcome: "gateRejected", taskKey: "CP-1")))

    #expect(request != nil)
}

@Test func notifiesWhenATaskNeedsAHuman() {
    let request = notification(
        for: .outcome(Outcome(outcome: "blocked", taskKey: "CP-1", detail: "ambiguous scope")))

    #expect(request?.title == "CP-1 needs a human")
    #expect(request?.body == "ambiguous scope")
}

@Test func notifiesWhenTheUsageLimitIsHit() {
    #expect(notification(for: .quota(Quota(status: "rejected")))?.title == "Usage limit reached")
}

// Six notifications, and only six. Anything else and the operator turns them off.
@Test func staysSilentOnAWarningThatIsNotYetALimit() {
    #expect(notification(for: .quota(Quota(status: "allowed_warning", utilization: 0.9))) == nil)
}

@Test func staysSilentOnAnAllowedQuotaReading() {
    #expect(notification(for: .quota(Quota(status: "allowed"))) == nil)
}

@Test func staysSilentOnOrdinaryProgress() {
    #expect(notification(for: .progress(Progress(phase: "agent"))) == nil)
}

@Test func staysSilentOnARequeue() {
    #expect(notification(for: .outcome(Outcome(outcome: "requeued", taskKey: "CP-1"))) == nil)
}

@Test func staysSilentOnAReleaseAndAFailure() {
    #expect(notification(for: .outcome(Outcome(outcome: "released", taskKey: "CP-1"))) == nil)
    #expect(notification(for: .outcome(Outcome(outcome: "failed", taskKey: "CP-1"))) == nil)
}

/// BP-609. The fifth. A machine fault hands the task back with its attempt refunded and says
/// nothing on the board that asks for the operator — so without this the machine goes on failing
/// every task it claims and the first they hear of it is an empty column.
@Test func notifiesWhenTheMachineItselfCannotRunTheWork() {
    let request = notification(
        for: .outcome(Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no sandbox here")))

    #expect(request?.title == machineFaultHeadline)
    #expect(request?.body.contains("CP-1") == true)
    #expect(request?.body.contains("no sandbox here") == true)
}

// It is not the task's fault, so the notification must not read like one when the reason is missing
@Test func stillNotifiesWhenTheFaultCameWithNoReason() {
    let request = notification(for: .outcome(Outcome(outcome: "machineFault", taskKey: "CP-1")))

    #expect(request != nil)
    #expect(request?.body.contains("Reason: on the board") == true)
}

// With autoMerge off, "delivered" is what a successful run ends as — and the operator has to act
// on it, so it is exactly the kind of thing worth interrupting them for.
@Test func notifiesWhenAPullRequestIsWaiting() {
    let request = notification(
        for: .outcome(Outcome(outcome: "delivered", taskKey: "CP-3", detail: "https://x/pull/7")))

    #expect(request?.title == "CP-3 is ready for review")
    #expect(request?.body == "https://x/pull/7")
}

@Test func fallsBackToPlainWordingWhenNoUrlCameThrough() {
    let request = notification(for: .outcome(Outcome(outcome: "delivered", taskKey: "CP-3")))

    #expect(request?.body.contains("did not merge") == true)
}


/**
 * BP-609 review. The fault recurs on every poll — refunded attempt, same task, same broken machine
 * thirty seconds later — so an unguarded notification stacks one banner per poll all night. This is
 * the menubar's half of the worker's own ReleaseMemory.
 *
 * The details below are the shapes the worker actually sends, not short stand-ins. The first
 * attempt at this dedupe keyed on the detail and passed a suite of hand-written strings while
 * failing on every one of these: the remote and the worktree path are what make two recurrences of
 * one fault look different, and the 200-character cap is what makes two different faults look the
 * same.
 */
private func fault(_ taskKey: String, _ detail: String) -> TelemetryEvent {
    .outcome(Outcome(outcome: "machineFault", taskKey: taskKey, detail: detail))
}

/**
 * pipeline.ts:411 — `String(error)` with the class names stripped, which names the project's remote.
 *
 * A TRANSPORT failure, deliberately. The first version of this helper built `<url> did not report
 * <ref>`, which workspace.ts throws with kind `configuration` and pipeline.ts routes to `requeued`
 * — so the fixture was a sentence this path can never send, and the worker's own suite uses that
 * same sentence as its requeued control. Two suites disagreeing about what one sentence means
 * (found in review). The property these tests rest on is unchanged: every transport message carries
 * the remote, so two projects meet one fault as two texts.
 */
private func baseBranchFault(_ taskKey: String, remote: String) -> TelemetryEvent {
    fault(
        taskKey,
        "could not resolve base branch main: could not read refs/heads/main from \(remote) "
            + "(fatal: Could not read from remote repository.)")
}

// pipeline.ts:601 — confine()'s refusal, which names the worktree, which carries the task key
private func gateFault(_ taskKey: String) -> TelemetryEvent {
    fault(
        taskKey,
        "the review gate could not run: cannot confine the agent to "
            + "/Users/op/worktrees/\(taskKey.lowercased())/wt: Error: ENOENT")
}

@Test func reportsARecurringFaultOnceRatherThanOncePerPoll() {
    var streak = FaultStreak()
    let recurring = baseBranchFault("CP-1", remote: "https://github.com/acme/api.git")

    #expect(streak.admit(recurring) != nil)
    #expect(streak.admit(recurring) == nil)
    #expect(streak.admit(recurring) == nil)
}

/**
 * The case that sank the first attempt. A worker serving two projects meets one machine-wide fault
 * as two different sentences, because each names its own remote — and `loop.ts`'s passOrder rotates
 * the projects, so they alternate. Keyed on the detail this notified every thirty seconds for ever.
 *
 * Bounded by the number of projects, not silent: each one says so once. That is the price of
 * scoping, and the alternative — one flag for the fleet — is the test below.
 */
@Test func oneMachineFaultAcrossTwoProjectsIsAnnouncedOncePerProjectAndThenNotAgain() {
    var streak = FaultStreak()
    let a = baseBranchFault("AA-1", remote: "https://github.com/acme/api.git")
    let b = baseBranchFault("BB-7", remote: "https://github.com/acme/web.git")

    #expect(streak.admit(a) != nil)
    #expect(streak.admit(b) != nil)
    #expect(streak.admit(a) == nil)
    #expect(streak.admit(b) == nil)
    #expect(streak.admit(baseBranchFault("AA-9", remote: "https://github.com/acme/api.git")) == nil)
}

/**
 * The one a fleet-wide flag cannot pass, and it is not a race: `loop.ts`'s passOrder moves a
 * faulting project to the END of the next pass, so the healthy project's outcome lands immediately
 * before the faulting project's fault on every pass after the first. One flag is cleared and
 * re-armed for ever — a banner per pass, at the cadence of however healthy the rest of the fleet
 * is, which is backwards (found in review).
 */
@Test func aHealthySiblingProjectDoesNotRearmTheFaultingOne() {
    var streak = FaultStreak()
    let broken = baseBranchFault("AA-1", remote: "https://github.com/acme/api.git")

    #expect(streak.admit(broken) != nil)
    for pass in 1...5 {
        _ = streak.admit(.outcome(Outcome(outcome: "merged", taskKey: "BB-\(pass)")))
        #expect(streak.admit(broken) == nil, "pass \(pass) re-announced a fault nothing changed about")
    }
}

// The other direction: the project that recovered is the one whose next fault is news again, and
// only that one.
@Test func aProjectThatRecoveredIsNewsWhenItFaultsAgain() {
    var streak = FaultStreak()
    let a = baseBranchFault("AA-1", remote: "https://github.com/acme/api.git")
    let b = baseBranchFault("BB-7", remote: "https://github.com/acme/web.git")

    #expect(streak.admit(a) != nil)
    #expect(streak.admit(b) != nil)
    _ = streak.admit(.outcome(Outcome(outcome: "merged", taskKey: "AA-2")))
    #expect(streak.admit(a) != nil)
    #expect(streak.admit(b) == nil)
}

// The other half of it: the gate path's reason carries the worktree path, so every task recurring
// through the same broken sandbox read as new.
@Test func theSameGateFaultOnAnotherTaskIsStillTheSameNews() {
    var streak = FaultStreak()

    #expect(streak.admit(gateFault("CP-1")) != nil)
    #expect(streak.admit(gateFault("CP-2")) == nil)
}

/**
 * The control, without which the dedupe would be silence. An outcome that is not a fault is the
 * machine proving it can work, so the next fault is news again. A run merely STARTING is not that
 * — progress precedes a fault on every recurrence — which is the second half of this test.
 */
@Test func aFaultAfterAHealthyRunIsReportedAgain() {
    var streak = FaultStreak()
    let recurring = gateFault("CP-1")

    #expect(streak.admit(recurring) != nil)
    // The same project, which is what makes it evidence about this project
    _ = streak.admit(.outcome(Outcome(outcome: "merged", taskKey: "CP-2")))
    #expect(streak.admit(recurring) != nil)
}

// Restarting the worker is what an operator does to fix a machine, and it emits no outcome — so
// the streak has to end with the socket or the first fault afterwards is the silent one.
@Test func aFaultAfterTheWorkerWentAwayIsReportedAgain() {
    var streak = FaultStreak()
    let recurring = gateFault("CP-1")

    #expect(streak.admit(recurring) != nil)
    #expect(streak.admit(recurring) == nil)
    streak.disconnected()
    #expect(streak.admit(recurring) != nil)
}

/**
 * The six tests above drive `FaultStreak` as a value; nothing drove the object the app holds, so
 * reverting the Notifier to ask `notification(for:)` instead left every one of them green (found in
 * review). This closes that for the decision. It does not close `handle`'s own call to it — that
 * line ends at UNUserNotificationCenter and no test here reaches it.
 */
// `Notifier.shared` is a static, and this is the only test that touches it. That is what makes the
// bracketing below enough; a second test on the shared object needs a different answer.
@MainActor
@Test func theNotifierItselfDedupesRatherThanJustOwningSomethingThatCould() {
    let recurring = gateFault("CP-1")
    Notifier.shared.workerDisconnected()

    #expect(Notifier.shared.request(for: recurring) != nil)
    #expect(Notifier.shared.request(for: recurring) == nil)
    Notifier.shared.workerDisconnected()
    #expect(Notifier.shared.request(for: recurring) != nil)
    Notifier.shared.workerDisconnected()
}

// The operator has to read the consequence before the reason: a banner is cut after a couple of
// lines and the reason can be 200 characters of git's stderr.
// The pair drifted apart once already inside this review, so the constant is the invariant and
// this is the assertion that it is still the one both sides use.
@Test func theNotificationTitleIsTheSentenceThePanelShows() {
    let request = notification(for: gateFault("CP-1"))

    #expect(request?.title == machineFaultHeadline)
}

@Test func theFaultBodySaysWhatHappenedBeforeItSaysWhy() throws {
    let request = notification(for: gateFault("CP-1"))
    let body = try #require(request?.body)

    let stopped = try #require(body.range(of: "take no more work until the next poll"))
    let why = try #require(body.range(of: "cannot confine"))
    #expect(stopped.lowerBound < why.lowerBound)
}

@Test func progressBetweenTwoFaultsDoesNotMakeTheSecondNews() {
    var streak = FaultStreak()
    let recurring = gateFault("CP-1")

    #expect(streak.admit(recurring) != nil)
    _ = streak.admit(.progress(Progress(phase: "claiming")))
    #expect(streak.admit(recurring) == nil)
}

// Everything that is not a fault still reaches the same decision it always did, repeats included:
// the streak must not become a throttle on the other five notifications.
@Test func theStreakPassesEveryOtherEventStraightThrough() {
    var streak = FaultStreak()

    #expect(streak.admit(.outcome(Outcome(outcome: "merged", taskKey: "CP-1"))) != nil)
    #expect(streak.admit(.outcome(Outcome(outcome: "merged", taskKey: "CP-1"))) != nil)
    #expect(streak.admit(.quota(Quota(status: "rejected"))) != nil)
    #expect(streak.admit(.outcome(Outcome(outcome: "requeued", taskKey: "CP-1"))) == nil)
    #expect(streak.admit(.progress(Progress(phase: "agent"))) == nil)
}

/**
 * Nothing but this ties the outcome literals in this app to the worker that emits them. Both sides
 * are strings, and the Swift tests are written against the same literals as the Swift source, so a
 * rename in `OutcomeKind` would leave the menubar silent and idle — the exact state BP-609 exists
 * to fix — with every test green. Same shape as the worker's own catalog-contract test: read the
 * source as text and compare.
 *
 * The list is read out of the sources rather than written here, because a hand-written one is a
 * list the next case can be left out of, and the claim is "every".
 */
@Test func everyOutcomeThisAppSwitchesOnIsOneTheWorkerCanEmit() throws {
    let menubar = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let root = menubar.deletingLastPathComponent()

    // Comments stripped, on both sides. Without it this test was fooled by the one edit it exists
    // to catch: a rename arrives with `// was "machineFault", now:` above it, the old word is still
    // in the window, and `contains` is satisfied by the explanation for its own removal (found in
    // review — the same hole catalog-contract.test.ts had one package over).
    func read(_ url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: #"/\*[\s\S]*?\*/"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?m)//.*$"#, with: "", options: .regularExpression)
    }

    let notifier = try read(menubar.appendingPathComponent("Sources/CPMenubarCore/Notifier.swift"))
    let state = try read(menubar.appendingPathComponent("Sources/CPMenubarCore/WorkerState.swift"))

    func matches(_ source: String, _ pattern: String) -> [String] {
        let regex = try! NSRegularExpression(pattern: pattern)
        let range = NSRange(source.startIndex..., in: source)
        return regex.matches(in: source, range: range).compactMap {
            Range($0.range(at: 1), in: source).map { r in String(source[r]) }
        }
    }

    // `case "delivered":` in the outcome switch, and `outcome.outcome == "blocked"` in apply()
    let inTheSwitch = matches(notifier, #"(?m)^\s*case "(\w+)":"#)
    let inTheState = matches(state, #"outcome\.outcome == "(\w+)""#)
    // Asserted separately because WorkerState's literals are a subset of Notifier's: reformatting
    // that file so the second pattern matched nothing left this test green, so its silence was
    // undetectable (found in review).
    #expect(!inTheState.isEmpty, "the WorkerState scanner found nothing — did that file change shape?")
    let switchedOn = Set(inTheSwitch + inTheState)

    let telemetry = try read(root.appendingPathComponent("worker/src/telemetry.ts"))
    let opening = try #require(
        telemetry.range(of: "export type OutcomeKind ="), "telemetry.ts no longer declares OutcomeKind")
    let kinds = telemetry[opening.upperBound...]
    let closing = try #require(kinds.range(of: ";"), "the OutcomeKind union is unterminated")
    let declared = String(kinds[..<closing.lowerBound])

    // Counted against the switch itself rather than a floor written here: `>= 5` could not see a
    // scanner that found four of six, and it is the same number-to-remember the derived list was
    // written to get rid of (found in review). Counted by splitting rather than by the same regex,
    // which would only be comparing the scanner with itself.
    let casesInTheSwitch = notifier.components(separatedBy: "case \"").count - 1
    #expect(casesInTheSwitch > 0)
    #expect(switchedOn.count >= casesInTheSwitch, "the scanner missed a case the switch has")
    #expect(switchedOn.contains("machineFault"), "the fault case is what BP-609 added; it must be here")
    for outcome in switchedOn.sorted() {
        #expect(declared.contains("\"\(outcome)\""), "the worker cannot emit \(outcome)")
    }
}
