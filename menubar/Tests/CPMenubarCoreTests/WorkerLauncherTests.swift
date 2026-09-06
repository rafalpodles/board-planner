import XCTest
@testable import CPMenubarCore

final class WorkerLauncherTests: XCTestCase {
    private let finderEnvironment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]

    private func state() -> OnboardingState {
        OnboardingState(
            step: .starting,
            apiURL: "https://app.example.com",
            workerName: "rpo-MacBook",
            checkoutsFolder: "/Users/rpo/checkouts",
            checkoutPath: "/Users/rpo/checkouts/thing",
            toolPath: "/Users/rpo/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/Users/rpo/.local/bin:/usr/bin:/bin"
        )
    }

    func testTheSpawnedWorkerGetsThePathPreflightResolved() {
        let plan = WorkerLauncher.plan(
            nodePath: "/Users/rpo/.nvm/versions/node/v22/bin/node",
            workerEntry: "/checkout/worker/dist/main.js",
            state: state(),
            stateDirectory: "/Users/rpo/.boardplanner",
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

    func testAnUnresolvedPathIsLeftAlone() {
        var bare = state()
        bare.toolPath = ""

        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: bare,
            stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.environment["PATH"], finderEnvironment["PATH"])
    }

    func testItSetsTheSameVariablesThePlistDoes() {
        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: state(),
            stateDirectory: "/Users/rpo/.boardplanner", baseEnvironment: finderEnvironment)

        XCTAssertEqual(plan.environment["CP_API_URL"], "https://app.example.com")
        XCTAssertEqual(plan.environment["CP_WORKER_NAME"], "rpo-MacBook")
        XCTAssertEqual(plan.environment["CP_STATE_DIR"], "/Users/rpo/.boardplanner")
    }

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

    func testItDoesNotInventAnApiToken() {
        let plan = WorkerLauncher.plan(
            nodePath: "/n", workerEntry: "/e", state: state(),
            stateDirectory: "/s", baseEnvironment: finderEnvironment)

        XCTAssertNil(plan.environment["CP_API_TOKEN"])
        XCTAssertNil(plan.environment["CP_ENROLMENT_TOKEN"])
    }

    func testItPrefersTheWorkerShippedInsideTheApp() throws {
        let bundled = try temporaryFile(named: "main.js")
        defer { try? FileManager.default.removeItem(atPath: bundled) }

        XCTAssertEqual(
            WorkerLauncher.entryPoint(bundledAt: bundled, checkout: "/Users/rpo/anything"),
            bundled)
    }

    func testItFallsBackToACheckoutThatHasOne() throws {
        let checkout = try temporaryCheckoutWithWorker()
        defer { try? FileManager.default.removeItem(atPath: checkout) }

        XCTAssertEqual(
            WorkerLauncher.entryPoint(bundledAt: "/nope/main.js", checkout: checkout),
            (checkout as NSString).appendingPathComponent("worker/dist/main.js"))
    }

    func testItAnswersNothingWhenNeitherExists() {
        XCTAssertNil(WorkerLauncher.entryPoint(bundledAt: "/nope/main.js", checkout: "/Users/rpo/their-project"))
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
