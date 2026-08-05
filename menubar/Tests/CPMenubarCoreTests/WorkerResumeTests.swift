import XCTest
@testable import CPMenubarCore

final class WorkerResumeTests: XCTestCase {
    // The gap this closes: the app registers itself as a login item, so it comes up at login — and
    // came up next to no worker at all, because startWorker() only ever ran at the end of the clone
    // step.
    func testAnOnboardedMachineWithNothingRunningStartsOne() {
        XCTAssertTrue(
            WorkerResume.shouldStart(
                isOnboarded: true, weAlreadyStartedOne: false, somethingIsListening: false))
    }

    // Two workers against one state directory share a credential and both claim tasks
    func testItNeverStartsASecondOne() {
        XCTAssertFalse(
            WorkerResume.shouldStart(
                isOnboarded: true, weAlreadyStartedOne: true, somethingIsListening: false))
        XCTAssertFalse(
            WorkerResume.shouldStart(
                isOnboarded: true, weAlreadyStartedOne: false, somethingIsListening: true))
    }

    // A worker from a launchd plist or a terminal is not ours to manage — the same line
    // RunningWorker draws when it refuses to stop one it did not start
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
