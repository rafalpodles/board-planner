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

    #expect(request?.title == "This machine couldn't run the work")
    #expect(request?.body.contains("CP-1") == true)
    #expect(request?.body.contains("no sandbox here") == true)
}

// It is not the task's fault, so the notification must not read like one when the reason is missing
@Test func stillNotifiesWhenTheFaultCameWithNoReason() {
    let request = notification(for: .outcome(Outcome(outcome: "machineFault", taskKey: "CP-1")))

    #expect(request != nil)
    #expect(request?.body.contains("the reason is on the board") == true)
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
 */
@Test func reportsARecurringFaultOnceRatherThanOncePerPoll() {
    var memory = FaultMemory()
    let fault = TelemetryEvent.outcome(
        Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no route to host"))

    #expect(memory.admit(fault) != nil)
    #expect(memory.admit(fault) == nil)
    #expect(memory.admit(fault) == nil)
}

// The recurrence claims a different task each pass on a busy board; the news is the machine, so the
// task key must not be what makes it new.
@Test func theSameFaultOnAnotherTaskIsStillTheSameNews() {
    var memory = FaultMemory()

    #expect(memory.admit(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no route to host"))) != nil)
    #expect(memory.admit(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-2", detail: "no route to host"))) == nil)
}

// The control, without which the dedupe would be silence: a genuinely different fault is news.
@Test func aDifferentFaultIsReportedAgain() {
    var memory = FaultMemory()

    #expect(memory.admit(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no route to host"))) != nil)
    #expect(memory.admit(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no sandbox here"))) != nil)
}

// A run that ended some other way means the machine worked, so the same fault afterwards is new.
// A run merely STARTING is not that — a fault emits after a progress event on every recurrence.
@Test func aFaultAfterAHealthyRunIsReportedAgain() {
    var memory = FaultMemory()
    let fault = TelemetryEvent.outcome(
        Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no route to host"))

    #expect(memory.admit(fault) != nil)
    _ = memory.admit(.outcome(Outcome(outcome: "merged", taskKey: "CP-2")))
    #expect(memory.admit(fault) != nil)
}

@Test func progressBetweenTwoIdenticalFaultsDoesNotMakeTheSecondNews() {
    var memory = FaultMemory()
    let fault = TelemetryEvent.outcome(
        Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no route to host"))

    #expect(memory.admit(fault) != nil)
    _ = memory.admit(.progress(Progress(phase: "claiming")))
    #expect(memory.admit(fault) == nil)
}

// Everything that is not a fault still reaches the same decision it always did.
@Test func theMemoryPassesEveryOtherEventStraightThrough() {
    var memory = FaultMemory()

    #expect(memory.admit(.outcome(Outcome(outcome: "merged", taskKey: "CP-1"))) != nil)
    #expect(memory.admit(.outcome(Outcome(outcome: "merged", taskKey: "CP-1"))) != nil)
    #expect(memory.admit(.quota(Quota(status: "rejected"))) != nil)
    #expect(memory.admit(.progress(Progress(phase: "agent"))) == nil)
}

/**
 * Nothing but this ties the literal above to the worker that emits it. Both sides are strings, the
 * Swift tests use the same literal as the Swift source, so a rename in `OutcomeKind` would leave
 * the menubar silent and idle — the exact state BP-609 exists to fix — with every test green.
 * Same shape as the worker's own catalog-contract test: read the source as text and compare.
 */
@Test func theOutcomeThisSwitchesOnIsOneTheWorkerCanEmit() throws {
    let telemetry = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("worker/src/telemetry.ts")
    let source = try String(contentsOf: telemetry, encoding: .utf8)
    let kinds = source[source.range(of: "export type OutcomeKind =")!.upperBound...]
    let declared = String(kinds[..<kinds.range(of: ";")!.lowerBound])

    for outcome in ["machineFault", "merged", "delivered", "gateRejected", "blocked"] {
        #expect(declared.contains("\"\(outcome)\""), "worker cannot emit \(outcome)")
    }
}
