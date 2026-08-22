import XCTest
@testable import CPMenubarCore

final class OnboardingTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let suite = UserDefaults(suiteName: "onboarding-\(UUID().uuidString)")!
        return suite
    }

    func testStartsNeedingPreflight() {
        XCTAssertEqual(Onboarding.load(defaults: defaults()).step, .needsPreflight)
        XCTAssertFalse(OnboardingState().isOnboarded)
    }

    // Stored canonical, so the next consumer does not have to know it needs fixing up
    func testWhatSomebodyTypesIsStoredAsAnAddressThatWorks() {
        let state = Onboarding.preflightPassed(
            OnboardingState(), apiURL: "localhost:3973", workerName: "mac", toolPath: "/bin")

        XCTAssertEqual(state.apiURL, "http://localhost:3973")
    }

    func testSurvivesARelaunch() {
        let store = defaults()
        var state = OnboardingState()
        state = Onboarding.preflightPassed(state, apiURL: "https://app", workerName: "mac", toolPath: "/opt/bin")
        state = Onboarding.folderChosen(state, path: "/checkout")
        Onboarding.save(state, defaults: store)

        let reloaded = Onboarding.load(defaults: store)

        XCTAssertEqual(reloaded.step, .awaitingApproval)
        XCTAssertEqual(reloaded.checkoutsFolder, "/checkout")
        XCTAssertEqual(reloaded.toolPath, "/opt/bin")
    }

    // The whole point of recording this: a browser nobody came back to used to leave repos.json
    // written and the app in a state with no name.
    func testAnAbandonedApprovalKeepsTheFolderAndAsksAgain() {
        var state = Onboarding.folderChosen(OnboardingState(), path: "/checkout")
        state = Onboarding.approvalStarted(state, deviceCode: "cpd_x", userCode: "BCDF2345", verificationURL: "https://app/enrol/BCDF2345")

        let after = Onboarding.approvalAbandoned(state)

        XCTAssertEqual(after.step, .awaitingApproval)
        XCTAssertEqual(after.checkoutsFolder, "/checkout")
        XCTAssertEqual(after.deviceCode, "", "an abandoned device code must not be kept")
        XCTAssertEqual(after.userCode, "")
    }

    func testApprovalSpendsTheDeviceCode() {
        var state = Onboarding.folderChosen(OnboardingState(), path: "/checkout")
        state = Onboarding.approvalStarted(state, deviceCode: "cpd_x", userCode: "BCDF2345", verificationURL: "u")

        let after = Onboarding.approved(state, workerID: "w1")

        XCTAssertEqual(after.step, .starting)
        XCTAssertEqual(after.workerID, "w1")
        XCTAssertEqual(after.deviceCode, "", "a spent secret must not be left in defaults")
    }

    // Re-entering a step is re-running one function, so running preflight again out of curiosity
    // must not walk a working machine back to the beginning
    func testPreflightRunAgainDoesNotUnwindARunningWorker() {
        var state = Onboarding.folderChosen(OnboardingState(), path: "/checkout")
        state = Onboarding.approved(state, workerID: "w1")
        state = Onboarding.started(state)
        XCTAssertTrue(state.isOnboarded)

        let after = Onboarding.preflightPassed(state, apiURL: "https://app", workerName: "mac", toolPath: "/new/bin")

        XCTAssertEqual(after.step, .running, "already running must stay running")
        XCTAssertEqual(after.toolPath, "/new/bin", "but a freshly resolved PATH is still adopted")
    }

    func testChoosingAnotherFolderWhileRunningDoesNotRestartTheFlow() {
        var state = Onboarding.folderChosen(OnboardingState(), path: "/one")
        state = Onboarding.started(Onboarding.approved(state, workerID: "w1"))

        let after = Onboarding.folderChosen(state, path: "/two")

        XCTAssertEqual(after.step, .running)
        XCTAssertEqual(after.checkoutsFolder, "/two")
    }

    func testEachStepIsSafeToRepeat() {
        var state = OnboardingState()
        for _ in 0..<3 {
            state = Onboarding.preflightPassed(state, apiURL: "https://app", workerName: "mac", toolPath: "/bin")
        }
        XCTAssertEqual(state.step, .needsFolder)

        for _ in 0..<3 { state = Onboarding.folderChosen(state, path: "/checkout") }
        XCTAssertEqual(state.step, .awaitingApproval)

        for _ in 0..<3 { state = Onboarding.approved(state, workerID: "w1") }
        XCTAssertEqual(state.step, .starting)

        for _ in 0..<3 { state = Onboarding.started(state) }
        XCTAssertEqual(state.step, .running)
    }

    func testResetForgetsEverything() {
        let store = defaults()
        Onboarding.save(Onboarding.started(OnboardingState()), defaults: store)
        Onboarding.reset(defaults: store)

        XCTAssertEqual(Onboarding.load(defaults: store).step, .needsPreflight)
    }
}

// BP-376. The board's address was asked for once and never again: FirstRunView is only shown while
// the machine is not onboarded, so the field holding it — and the button beside it — were both
// unreachable for the rest of the machine's life.
final class ChangingBoardTests: XCTestCase {
    private func running() -> OnboardingState {
        OnboardingState(
            step: .running, apiURL: "http://localhost:3958", workerName: "rig-mac",
            checkoutsFolder: "/Users/rpo/checkouts", checkoutPath: "/Users/rpo/checkouts/BP",
            userCode: "ABCD-1234", deviceCode: "cpd_x", workerID: "w1",
            toolPath: "/opt/homebrew/bin")
    }

    func testItReturnsToTheScreenThatAsksForTheAddress() {
        let next = Onboarding.changingBoard(running())

        XCTAssertFalse(next.isOnboarded)
        XCTAssertEqual(next.step, .needsFolder)
    }

    // A change of board, not a fresh machine: asking for the folder and the tools again is asking
    // the operator to redo a setup that is still true.
    func testItKeepsWhatDescribesTheMachineRatherThanTheBoard() {
        let next = Onboarding.changingBoard(running())

        XCTAssertEqual(next.checkoutsFolder, "/Users/rpo/checkouts")
        XCTAssertEqual(next.toolPath, "/opt/homebrew/bin")
        XCTAssertEqual(next.workerName, "rig-mac")
        // The address being changed is the one worth showing in the field about to be edited
        XCTAssertEqual(next.apiURL, "http://localhost:3958")
    }

    // What the old board minted describes a relationship that is ending. A worker id left behind
    // would have this machine reporting as somebody the new board has never registered.
    func testItDropsWhatTheOldBoardMinted() {
        let next = Onboarding.changingBoard(running())

        XCTAssertEqual(next.workerID, "")
        XCTAssertEqual(next.checkoutPath, "")
        XCTAssertEqual(next.userCode, "")
        XCTAssertEqual(next.deviceCode, "")
    }
}
