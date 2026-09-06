import XCTest
@testable import CPMenubarCore

final class WorkerLauncherTests: XCTestCase {
    // What a Finder launch actually gives you, and what makes this whole task necessary
    private let finderEnvironment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]

    private func state() -> OnboardingState {
        OnboardingState(
            step: .starting,
            apiURL: "https://app.example.com",
            workerName: "owner-macbook",
            checkoutsFolder: "/Users/owner/checkouts",
            checkoutPath: "/Users/owner/checkouts/thing",
            toolPath: "/Users/owner/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/Users/owner/.local/bin:/usr/bin:/bin"
        )
    }

    // The failure this exists to prevent: preflight finds claude through a login shell, the app
    // spawns a worker that inherits Finder's PATH, and every task fails with the check still green.
    func testTheSpawnedWorkerGetsThePathPreflightResolved() {
        let plan = WorkerLauncher.plan(
            nodePath: "/Users/owner/.nvm/versions/node/v22/bin/node",
            workerEntry: "/checkout/worker/dist/main.js",
            state: state(),
            stateDirectory: "/Users/owner/.boardplanner",
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
            stateDirectory: "/Users/owner/.boardplanner", baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.environment["CP_API_URL"], "https://app.example.com")
        XCTAssertEqual(plan.environment["CP_WORKER_NAME"], "owner-macbook")
        XCTAssertEqual(plan.environment["CP_STATE_DIR"], "/Users/owner/.boardplanner")
    }

    // Shipped once. The worker registered, cloned, started and then never reported, and the fleet
    // console said "stale" — because Node's fetch rejects a scheme-less URL outright while every
    // Swift-side client had quietly normalised it first. The old test used a fixture that already
    // carried https://, so it passed throughout.
    func testTheWorkerIsHandedSomethingFetchCanParse() {
        for typed in ["localhost:3973", "board.example.com", "127.0.0.1:3000", "shed.local:8080"] {
            var typedByHand = state()
            typedByHand.apiURL = typed

            let plan = WorkerLauncher.plan(
                nodePath: "/n", workerEntry: "/e", state: typedByHand,
                stateDirectory: "/s", baseEnvironment: finderEnvironment)

            let handed = plan.environment["CP_API_URL"] ?? ""
            XCTAssertTrue(
                handed.hasPrefix("http://") || handed.hasPrefix("https://"),
                "\(typed) reached the worker as \(handed), which fetch cannot parse")
            XCTAssertNotNil(URL(string: handed)?.host, "\(handed) has no host")
        }
    }

    func testAnAddressThatLeavesTheMachineKeepsTLS() {
        var typedByHand = state()
        typedByHand.apiURL = "board.example.com"

        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: typedByHand,
            stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.environment["CP_API_URL"], "https://board.example.com")
    }

    func testAnExplicitSchemeIsLeftExactlyAsGiven() {
        for typed in ["http://localhost:3973", "https://board.example.com"] {
            var typedByHand = state()
            typedByHand.apiURL = typed

            let plan = WorkerLauncher.plan(
                nodePath: "/n", workerEntry: "/e", state: typedByHand,
                stateDirectory: "/s", baseEnvironment: finderEnvironment)

            XCTAssertEqual(plan.environment["CP_API_URL"], typed)
        }
    }

    // CP-237 removed it as a boot requirement, and the app must not quietly reintroduce one
    func testItDoesNotInventAnApiToken() {
        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: state(),
            stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertNil(plan.environment["CP_API_TOKEN"])
        XCTAssertNil(plan.environment["CP_ENROLMENT_TOKEN"])
    }

    // The app has to carry its own worker. A distributed app cannot read one out of the operator's
    // checkout, because that checkout is *their* project — only a Board Planner clone has worker/.
    // This looked fine right up until the app would have left the machine that built it.
    func testItPrefersTheWorkerShippedInsideTheApp() throws {
        let bundled = try temporaryFile(named: "main.js")
        defer { try? FileManager.default.removeItem(atPath: bundled) }

        XCTAssertEqual(
            WorkerLauncher.entryPoint(bundledAt: bundled, checkout: "/Users/owner/anything"),
            bundled)
    }

    func testItFallsBackToACheckoutThatHasOne() throws {
        let checkout = try temporaryCheckoutWithWorker()
        defer { try? FileManager.default.removeItem(atPath: checkout) }

        XCTAssertEqual(
            WorkerLauncher.entryPoint(bundledAt: "/nope/main.js", checkout: checkout),
            (checkout as NSString).appendingPathComponent("worker/dist/main.js"))
    }

    // Someone else's project, and no worker in the app: saying so beats spawning a path that is
    // not there and reporting whatever node says about it
    func testItAnswersNothingWhenNeitherExists() {
        XCTAssertNil(WorkerLauncher.entryPoint(bundledAt: "/nope/main.js", checkout: "/Users/owner/their-project"))
    }

    func testTheBundledWorkerLivesUnderResources() {
        XCTAssertEqual(
            WorkerLauncher.bundledEntryPoint(resourcePath: "/Apps/CPMenubar.app/Contents/Resources"),
            "/Apps/CPMenubar.app/Contents/Resources/worker/main.js")
        XCTAssertNil(WorkerLauncher.bundledEntryPoint(resourcePath: nil))
    }

    private func temporaryFile(named name: String) throws -> String {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cp-launch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(name)
        try Data().write(to: file)
        return file.path
    }

    private func temporaryCheckoutWithWorker() throws -> String {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cp-checkout-\(UUID().uuidString)")
        let dist = root.appendingPathComponent("worker/dist")
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
        try Data().write(to: dist.appendingPathComponent("main.js"))
        return root.path
    }

    func testItSpawnsNodeWithTheEntryPoint() {
        let plan = WorkerLauncher.plan(
            nodePath: "/usr/local/bin/node", workerEntry: "/c/worker/dist/main.js",
            state: state(), stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.executable, "/usr/local/bin/node")
        XCTAssertEqual(plan.arguments, ["/c/worker/dist/main.js"])
    }
}
