import XCTest
@testable import CPMenubarCore

final class WorkerResumeTests: XCTestCase {
    func testAnOnboardedMachineWithNothingRunningStartsOne() {
        XCTAssertTrue(
            WorkerResume.shouldStart(
                isOnboarded: true, weAlreadyStartedOne: false, somethingIsListening: false))
    }

    func testItNeverStartsASecondOne() {
        XCTAssertFalse(
            WorkerResume.shouldStart(
                isOnboarded: true, weAlreadyStartedOne: true, somethingIsListening: false))
        XCTAssertFalse(
            WorkerResume.shouldStart(
                isOnboarded: true, weAlreadyStartedOne: false, somethingIsListening: true))
    }

    func testSomebodyElsesWorkerIsLeftAlone() {
        XCTAssertFalse(
            WorkerResume.shouldStart(
                isOnboarded: true, weAlreadyStartedOne: false, somethingIsListening: true))
    }

    func testAMachineThatHasNotFinishedSetupStartsNothing() {
        XCTAssertFalse(
            WorkerResume.shouldStart(
                isOnboarded: false, weAlreadyStartedOne: false, somethingIsListening: false))
    }
}
