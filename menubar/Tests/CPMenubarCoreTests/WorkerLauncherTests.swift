import XCTest
@testable import CPMenubarCore

final class WorkerLauncherTests: XCTestCase {
    // What a Finder launch actually gives you, and what makes this whole task necessary
    private let finderEnvironment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]

    private func state() -> OnboardingState {
        OnboardingState(
            step: .starting,
            apiURL: "https://app.example.com",
            workerName: "rpo-MacBook",
            checkoutPath: "/Users/rpo/checkouts/thing",
            toolPath: "/Users/rpo/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/Users/rpo/.local/bin:/usr/bin:/bin"
        )
    }

    // The failure this exists to prevent: preflight finds claude through a login shell, the app
    // spawns a worker that inherits Finder's PATH, and every task fails with the check still green.
    func testTheSpawnedWorkerGetsThePathPreflightResolved() {
        let plan = WorkerLauncher.plan(
            nodePath: "/Users/rpo/.nvm/versions/node/v22/bin/node",
            workerEntry: "/checkout/worker/dist/main.js",
            state: state(),
            stateDirectory: "/Users/rpo/.claudeplanner",
            baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.environment["PATH"], state().toolPath)
        XCTAssertTrue(plan.environment["PATH"]!.contains("/opt/homebrew/bin"))
        XCTAssertTrue(plan.environment["PATH"]!.contains(".local/bin"), "claude installs itself here")
        XCTAssertTrue(plan.environment["PATH"]!.contains("node/v22/bin"), "npm's shebang is `env node`")
    }

    func testItNeverLeavesTheInheritedPathInPlace() {
        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: state(),
            stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertNotEqual(plan.environment["PATH"], finderEnvironment["PATH"])
    }

    // Only ever an addition. A worker with no resolved PATH must keep whatever it was given rather
    // than being handed an empty one, which would be worse than the problem.
    func testAnUnresolvedPathIsLeftAlone() {
        var bare = state()
        bare.toolPath = ""

        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: bare,
            stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.environment["PATH"], finderEnvironment["PATH"])
    }

    // The app is a convenience over the launchd contract, never a replacement — so it sets exactly
    // the variables the plist sets, and the worker cannot tell which one started it
    func testItSetsTheSameVariablesThePlistDoes() {
        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: state(),
            stateDirectory: "/Users/rpo/.claudeplanner", baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.environment["CP_API_URL"], "https://app.example.com")
        XCTAssertEqual(plan.environment["CP_WORKER_NAME"], "rpo-MacBook")
        XCTAssertEqual(plan.environment["CP_STATE_DIR"], "/Users/rpo/.claudeplanner")
    }

    // CP-237 removed it as a boot requirement, and the app must not quietly reintroduce one
    func testItDoesNotInventAnApiToken() {
        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: state(),
            stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertNil(plan.environment["CP_API_TOKEN"])
        XCTAssertNil(plan.environment["CP_ENROLMENT_TOKEN"])
    }

    func testItRunsTheBuiltWorkerFromTheChosenCheckout() {
        XCTAssertEqual(
            WorkerLauncher.entryPoint(inCheckout: "/Users/rpo/checkouts/thing"),
            "/Users/rpo/checkouts/thing/worker/dist/main.js")
    }

    func testItSpawnsNodeWithTheEntryPoint() {
        let plan = WorkerLauncher.plan(
            nodePath: "/usr/local/bin/node", workerEntry: "/c/worker/dist/main.js",
            state: state(), stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.executable, "/usr/local/bin/node")
        XCTAssertEqual(plan.arguments, ["/c/worker/dist/main.js"])
    }
}
