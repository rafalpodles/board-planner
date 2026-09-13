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

// BP-609. A machine fault and a release are the same thing on the board — the task went back to
// the queue — so before this they left the same .idle menubar. .idle is what a machine with
// nothing to do looks like, and this one has work it cannot take.
@Test func aMachineFaultIsItsOwnHealthAndNotIdle() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no sandbox")), at: t0)

    #expect(state.health == .faulted)
}

// The loop claims nothing while paused, so a fault can only be the tail of a run that started
// before it. Overwriting .paused turns the panel's Resume button back into Pause on a worker that
// is still paused.
@Test func aFaultDoesNotUnpauseAPausedWorker() {
    var state = WorkerState()
    state.forceHealth(.paused)
    state.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1", detail: "no sandbox")), at: t0)

    #expect(state.health == .paused)
}

@Test func aReleasedOutcomeStillReadsAsIdle() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "released", taskKey: "CP-1", detail: "usage limit reached")), at: t0)

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
    #expect(state.iconName(now: t0) == "circle.fill")
}

@Test func losingTheSocketIsDisconnectedAndSaysSo() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)
    state.markDisconnected()

    #expect(state.health == .disconnected)
    #expect(state.iconName(now: t0) == "exclamationmark.triangle")
    #expect(state.title(now: t0) == nil)
}

@Test func everyHealthHasItsOwnIcon() {
    // allCases, not a literal: a hand-written list is one a new case can be left out of, and the
    // test's own claim is "every".
    let every = Health.allCases
    let icons = Set(every.map { health -> String in
        var state = WorkerState()
        state.forceHealth(health)
        return state.iconName(now: t0)
    })

    #expect(icons.count == every.count)
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

/**
 * BP-612. The loop claims nothing while paused, so an outcome arriving during a pause is the tail
 * of a run that started before it. Dropping `.paused` for it leaves a paused worker offering
 * "Pause", and pressing that sends `pause` to a worker that is already paused — the operator's way
 * back to work is a button that is no longer there.
 */
@Test func aBlockedOutcomeDoesNotUnpauseAPausedWorker() {
    var state = WorkerState()
    state.forceHealth(.paused)

    state.apply(.outcome(Outcome(outcome: "blocked", taskKey: "CP-1")), at: t0)

    #expect(state.health == .paused)
}

// The control: on a worker that is not paused, blocked still reaches the state that asks for a
// person.
@Test func aBlockedOutcomeStillNeedsAHuman() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)

    state.apply(.outcome(Outcome(outcome: "blocked", taskKey: "CP-1")), at: t0)

    #expect(state.health == .needsHuman)
}

/**
 * BP-616. `faulted` is sticky and nothing clears it on an idle machine: progress comes only from
 * inside a run, `adopt` runs once per socket connection, and a pass that claims nothing says
 * nothing. So the wrench icon outlived the fault by a night.
 */
@Test func aFaultThatNothingRepeatsStopsShowingAfterTheGrace() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1")), at: t0)

    #expect(state.effectiveHealth(now: t0.addingTimeInterval(60)) == .faulted)
    #expect(
        state.effectiveHealth(now: t0.addingTimeInterval(WorkerState.faultGrace + 1)) == .idle)
    #expect(
        state.iconName(now: t0.addingTimeInterval(WorkerState.faultGrace + 1))
            == WorkerState().iconName(now: t0))
}

// The case that matters, and the one a grace period could have broken: a machine failing on every
// poll keeps saying so, because each fault re-stamps the clock.
@Test func aMachineStillFaultingKeepsTheFaultIcon() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1")), at: t0)
    let later = t0.addingTimeInterval(WorkerState.faultGrace - 30)
    state.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1")), at: later)

    #expect(state.effectiveHealth(now: later.addingTimeInterval(60)) == .faulted)
}

// A reconnect re-reads the worker's real state, so a fault it did not report is over.
@Test func aReconnectEndsAFaultRatherThanLettingItExpire() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1")), at: t0)
    state.adopt(StatusResponse(paused: false, current: nil, recent: []), at: t0.addingTimeInterval(5))

    #expect(state.effectiveHealth(now: t0.addingTimeInterval(6)) == .idle)
}

// The stamp as well as the health, which the test above cannot see: `adopt` sets `.idle`, so it
// passes with the clock left behind (found in review). Reached through `forceHealth` because no
// event sets `.faulted` without stamping it — that is the whole point of clearing it here, and the
// day one does, a stale stamp would age the new fault out before it was ever drawn.
@Test func aReconnectDropsTheFaultClockAlongWithTheFault() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1")), at: t0)
    state.adopt(StatusResponse(paused: false, current: nil, recent: []), at: t0.addingTimeInterval(5))

    state.forceHealth(.faulted)

    #expect(state.effectiveHealth(now: t0.addingTimeInterval(WorkerState.faultGrace * 4)) == .faulted)
}

// The same for the socket dropping, which is the other path that ends a fault without an outcome.
@Test func aDisconnectDropsTheFaultClockAlongWithTheFault() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "CP-1")), at: t0)
    state.markDisconnected()

    state.forceHealth(.faulted)

    #expect(state.effectiveHealth(now: t0.addingTimeInterval(WorkerState.faultGrace * 4)) == .faulted)
}

// Nothing else expires. A machine waiting for a person is waiting until somebody comes.
@Test func nothingButAFaultIsAgedOut() {
    for health in Health.allCases where health != .faulted {
        var state = WorkerState()
        state.forceHealth(health)
        #expect(
            state.effectiveHealth(now: t0.addingTimeInterval(WorkerState.faultGrace * 10)) == health)
    }
}
