import Foundation
import Testing
@testable import CPMenubarCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func running(_ phase: String) -> WorkerState {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: phase, taskKey: "BP-1")), at: t0)
    return state
}

@Test func anIdleMachineShowsTheLogoAsItIs() {
    let glyph = WorkerState().iconGlyph(now: t0)

    #expect(glyph.opacities == IconGlyph.restingOpacities)
    #expect(glyph.badge == .none)
    #expect(glyph.breathing == nil)
}

@Test func claimingLightsNoCardAndTheFirstOneBreathes() {
    let glyph = running("claiming").iconGlyph(now: t0)

    #expect(glyph.opacities.allSatisfy { $0 == IconGlyph.unlitOpacity })
    #expect(glyph.breathing == 0)
}

@Test func eachLaterStageLightsOneMoreCard() {
    let lit = WorkerState.pipeline.map { phase in
        running(phase).iconGlyph(now: t0).opacities.filter { $0 == 1.0 }.count
    }

    #expect(lit == [0, 1, 2, 3, 4, 5, 6])
}

@Test func theCardForTheCurrentStageIsTheOneThatBreathes() {
    for (index, phase) in WorkerState.pipeline.enumerated() where index < IconGlyph.cardCount {
        #expect(running(phase).iconGlyph(now: t0).breathing == index, "\(phase)")
    }
}

@Test func mergingHasAllSixLitAndNothingLeftToBreathe() {
    let glyph = running("merge").iconGlyph(now: t0)

    #expect(glyph.opacities.allSatisfy { $0 == 1.0 })
    #expect(glyph.breathing == nil)
}

@Test func aGatePhaseLightsTheCardsForTheGatesStage() {
    #expect(running("gates:test-presence").iconGlyph(now: t0) == running("gates").iconGlyph(now: t0))
}

@Test func aPhaseThePipelineDoesNotKnowStillShowsARun() {
    let glyph = running("something-new").iconGlyph(now: t0)

    #expect(glyph.opacities.allSatisfy { $0 == IconGlyph.unlitOpacity })
    #expect(glyph.breathing == 0)
}

@Test func aPausedMachineIsDimmedRatherThanBadged() {
    var state = WorkerState()
    state.forceHealth(.paused)
    let glyph = state.iconGlyph(now: t0)

    #expect(glyph.opacities == IconGlyph.restingOpacities.map { $0 * 0.5 })
    #expect(glyph.badge == .none)
}

@Test func theBadgeShapesAreDistinctBecauseTheIconIsMonochrome() {
    let badges = [Health.needsHuman, .faulted, .disconnected].map { health -> IconGlyph.Badge in
        var state = WorkerState()
        state.forceHealth(health)
        return state.iconGlyph(now: t0).badge
    }

    #expect(badges == [.attention, .fault, .offline])
}
