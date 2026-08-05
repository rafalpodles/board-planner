import Foundation
import Testing
@testable import CPMenubarCore

private let t0 = Date(timeIntervalSince1970: 1_000_000)

@Test func startsIdle() {
    #expect(WorkerState().health == .idle)
}

@Test func aProgressEventMakesItWorking() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)

    #expect(state.health == .working)
    #expect(state.currentPhase == "agent")
}

@Test func aMergedOutcomeReturnsItToIdleAndCountsTheMerge() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)
    state.apply(.outcome(Outcome(outcome: "merged", taskKey: "CP-1")), at: t0)

    #expect(state.health == .idle)
    #expect(state.mergedToday == 1)
    #expect(state.currentPhase == nil)
}

// Only "blocked" means a human has to do something; a requeue is the worker's own business.
@Test func aBlockedOutcomeIsTheOneThatNeedsAHuman() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "blocked", taskKey: "CP-1", detail: "ambiguous")), at: t0)

    #expect(state.health == .needsHuman)
}

@Test func aRequeuedOutcomeDoesNotNeedAHuman() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "requeued", taskKey: "CP-1")), at: t0)

    #expect(state.health == .idle)
}

@Test func keepsTheLastFiveToolsNewestFirst() {
    var state = WorkerState()
    for i in 1...7 {
        state.apply(.progress(Progress(phase: "agent", tool: ToolActivity(name: "T\(i)"))), at: t0)
    }

    #expect(state.recentTools.map(\.name) == ["T7", "T6", "T5", "T4", "T3"])
}

@Test func adoptsAStatusSnapshotIncludingItsPausedFlag() {
    var state = WorkerState()
    state.adopt(StatusResponse(paused: true, current: Progress(phase: "push"), recent: []), at: t0)

    #expect(state.health == .paused)
    #expect(state.currentPhase == "push")
}

@Test func aPausedWorkerStaysPausedWhileTheRunItAlreadyHeldFinishes() {
    var state = WorkerState()
    state.adopt(StatusResponse(paused: true, current: Progress(phase: "agent"), recent: []), at: t0)
    state.apply(.progress(Progress(phase: "push")), at: t0)

    #expect(state.health == .paused)
}

@Test func theTitleNamesTheTaskThePhaseAndTheElapsedTime() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "gates:build", taskKey: "CP-161")), at: t0)

    #expect(state.title(now: t0.addingTimeInterval(102)) == "CP-161 · gates:build 1:42")
}

@Test func theTitleFallsBackToThePhaseWhenNoTaskIsNamed() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "claiming")), at: t0)

    #expect(state.title(now: t0.addingTimeInterval(5)) == "claiming 0:05")
}

@Test func theElapsedClockRestartsOnEachNewPhaseNotOnEachEvent() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent", taskKey: "CP-1")), at: t0)
    state.apply(
        .progress(Progress(phase: "agent", taskKey: "CP-1", tool: ToolActivity(name: "Read"))),
        at: t0.addingTimeInterval(30))

    #expect(state.title(now: t0.addingTimeInterval(60)) == "CP-1 · agent 1:00")
}

@Test func thereIsNoTitleWhenNothingIsRunning() {
    #expect(WorkerState().title(now: t0) == nil)
}

// A silent agent is the normal case mid-run; going amber here would cry wolf every long edit.
@Test func aQuietRunStillReadsAsWorking() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)

    #expect(state.health == .working)
    #expect(state.iconName() == "circle.fill")
}

@Test func losingTheSocketIsDisconnectedAndSaysSo() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)
    state.markDisconnected()

    #expect(state.health == .disconnected)
    #expect(state.iconName() == "exclamationmark.triangle")
    #expect(state.title(now: t0) == nil)
}

@Test func everyHealthHasItsOwnIcon() {
    let icons = Set([Health.idle, .working, .paused, .needsHuman, .disconnected].map { health -> String in
        var state = WorkerState()
        state.forceHealth(health)
        return state.iconName()
    })

    #expect(icons.count == 5)
}

@Test func theStepperMarksPassedPhasesDoneAndTheRestPending() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "push")), at: t0)

    let rows = state.stepperRows()

    #expect(rows.first { $0.phase == "claiming" }?.state == .done)
    #expect(rows.first { $0.phase == "push" }?.state == .active)
    #expect(rows.first { $0.phase == "merge" }?.state == .pending)
}

// Every gate collapses onto one row: the pipeline's gate count is project policy, not a fixed shape.
@Test func anyGatePhaseLandsOnTheSingleGatesStep() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "gates:test-presence")), at: t0)

    let rows = state.stepperRows()

    #expect(rows.first { $0.phase == "gates" }?.state == .active)
    #expect(rows.first { $0.phase == "agent" }?.state == .done)
}

@Test func aQuotaReadingIsRememberedWithoutDisturbingThePhase() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)
    state.apply(.quota(Quota(status: "allowed_warning", utilization: 0.9)), at: t0)

    #expect(state.currentPhase == "agent")
    #expect(state.lastQuota?.status == "allowed_warning")
}
