import XCTest

final class GitSpawnContractTests: XCTestCase {
    private func appSource(_ file: String) throws -> String {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(contentsOf: root.appending(path: "Sources/CPMenubar/\(file)"), encoding: .utf8)
    }

    func testEveryGitSpawnGoesThroughTheHardenedEnvironment() throws {
        let source = try appSource("WorkerProcess.swift")

        let assignments = source.components(separatedBy: "process.environment = ").count - 1
        let hardened = source.components(separatedBy: "process.environment = GitSafeEnvironment.apply").count - 1
        let spawnsSomethingElse = source.components(separatedBy: "\"gh\", \"auth\"").count - 1
        let launchesTheWorker = source.components(separatedBy: "plan.environment").count - 1

        XCTAssertEqual(
            hardened, assignments - spawnsSomethingElse - launchesTheWorker,
            "a Process here sets an environment that is not GitSafeEnvironment.apply(to:) — if it spawns git, harden it; if it does not, teach this test about it")
    }
}
