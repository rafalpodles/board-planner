import Foundation
import Testing
@testable import CPMenubarCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func state(_ events: [TelemetryEvent]) -> WorkerState {
    var state = WorkerState()
    for event in events { state.apply(event, at: t0) }
    return state
}

@Test func anIdleMachineSaysHowOftenItChecks() {
    let summary = WorkerState().panelSummary(now: t0, pollSeconds: 30)

    #expect(summary.headline == "Waiting for work")
    #expect(summary.detail == "Checking the board every 30 s.")
    #expect(summary.pill == "Connected")
}

@Test func anIdleMachineWithNoConfigStillSaysSomethingTrue() {
    #expect(WorkerState().panelSummary(now: t0, pollSeconds: nil).detail == "Checking the board for approved tasks.")
}

@Test func aRunNamesItsTaskTheStageAndTheTimeInIt() {
    let working = state([.progress(Progress(phase: "agent", taskKey: "BP-1076"))])

    let summary = working.panelSummary(now: t0.addingTimeInterval(252), pollSeconds: 30)

    #expect(summary.headline == "BP-1076")
    #expect(summary.detail == "The agent is working · 4:12")
    #expect(summary.pill == "Running")
}

@Test func everyStageHasASentenceOfItsOwn() {
    let sentences = WorkerState.pipeline.map { phase -> String in
        state([.progress(Progress(phase: phase, taskKey: "BP-1"))]).panelSummary(now: t0, pollSeconds: nil).detail
    }

    #expect(Set(sentences).count == WorkerState.pipeline.count)
}

@Test func aPhaseNobodyTaughtItIsStillSaid() {
    let summary = state([.progress(Progress(phase: "reviewing", taskKey: "BP-1"))]).panelSummary(now: t0, pollSeconds: nil)

    #expect(summary.detail.hasPrefix("Reviewing"))
}

@Test func aBlockedRunSaysWhichTaskIsWaiting() {
    let blocked = state([.outcome(Outcome(outcome: "blocked", taskKey: "BP-1075"))])

    let summary = blocked.panelSummary(now: t0, pollSeconds: nil)

    #expect(summary.headline == "Needs a human")
    #expect(summary.detail == "BP-1075 is waiting for you.")
}

@Test func aFaultUsesTheOneSentenceTheNotificationUses() {
    let faulted = state([.outcome(Outcome(outcome: "machineFault", taskKey: "BP-1"))])

    #expect(faulted.panelSummary(now: t0, pollSeconds: nil).headline == machineFaultHeadline)
}

@Test func aFaultThatAgedOutReadsAsIdleHere_asItDoesInTheIcon() {
    let faulted = state([.outcome(Outcome(outcome: "machineFault", taskKey: "BP-1"))])

    let later = t0.addingTimeInterval(WorkerState.faultGrace + 1)

    #expect(faulted.panelSummary(now: later, pollSeconds: nil).headline == "Waiting for work")
}

@Test func aRefusedSocketSaysWhyInsteadOfRetrying() {
    var offline = WorkerState()
    offline.markDisconnected(reason: "the directory is not yours")

    let summary = offline.panelSummary(now: t0, pollSeconds: nil)

    #expect(summary.headline == "Won't connect")
    #expect(summary.detail == "the directory is not yours")
}

@Test func anUnreachableWorkerSaysItIsRetrying() {
    var offline = WorkerState()
    offline.markDisconnected()

    #expect(offline.panelSummary(now: t0, pollSeconds: nil).detail == "Retrying every few seconds.")
}

@Test func everyHealthHasADistinctPill() {
    let pills = Set(Health.allCases.map { health -> String in
        var state = WorkerState()
        state.forceHealth(health)
        return state.panelSummary(now: t0, pollSeconds: nil).pill
    })

    #expect(pills.count == Health.allCases.count)
}

private var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
}

@Test func aWeeklyReadingNamesTheWindowAndWhenItResets() {
    // 2027-01-15 08:00 UTC is a Friday; the reset is the following Thursday
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let quota = Quota(status: "allowed_warning", utilization: 0.764, resetsAt: now.timeIntervalSince1970 + 5 * 86_400, rateLimitType: "seven_day")

    let summary = QuotaSummary(quota, now: now, calendar: utc)

    #expect(summary?.label == "Weekly limit")
    #expect(summary?.value == "76%")
    #expect(summary?.resets == "resets Wed")
    #expect(summary?.exhausted == false)
}

@Test func aResetLaterTodayIsAClockTime() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let quota = Quota(status: "allowed_warning", utilization: 0.9, resetsAt: now.timeIntervalSince1970 + 3_600, rateLimitType: "five_hour")

    let summary = QuotaSummary(quota, now: now, calendar: utc)

    #expect(summary?.label == "5-hour limit")
    #expect(summary?.resets?.hasPrefix("resets ") == true)
    #expect(summary?.resets?.contains(":") == true)
}

@Test func aRejectedReadingIsExhaustedWithoutANumber() {
    let summary = QuotaSummary(Quota(status: "rejected"), now: t0, calendar: utc)

    #expect(summary?.value == "Reached")
    #expect(summary?.exhausted == true)
}

// The CLI sends this event only near thresholds: a status with no number is nothing to put a tile on.
@Test func aReadingWithNoNumberAndNoRefusalHasNothingToShow() {
    #expect(QuotaSummary(Quota(status: "allowed"), now: t0, calendar: utc) == nil)
}

@Test func aTaskKeyBecomesItsPageOnTheBoard() {
    #expect(BoardURL.task(apiURL: "app.board-planner.com", key: "BP-1075")?.absoluteString
        == "https://app.board-planner.com/projects/BP/tasks/1075")
    #expect(BoardURL.task(apiURL: "localhost:3000", key: "CP-5")?.absoluteString
        == "http://localhost:3000/projects/CP/tasks/5")
}

@Test func aKeyThatIsNotProjectDashNumberIsNotALink() {
    for key in ["", "BP", "BP-", "-12", "BP-1x", "B/P-1", "BP-1/../x"] {
        #expect(BoardURL.task(apiURL: "app.board-planner.com", key: key) == nil, "\(key)")
    }
    #expect(BoardURL.task(apiURL: "", key: "BP-1") == nil)
}
