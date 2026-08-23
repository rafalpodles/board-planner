import XCTest

/// The app target is not unit-tested — it is SwiftUI and a `Process` or two — so a scan of its
/// source is the only guard available against a git spawned without the hardening. Same shape as
/// the worker's `git-safety.test.ts`, and for the same reason: the rule is easy to add once and
/// easy to forget the second time.
final class GitSpawnContractTests: XCTestCase {
    private func appSource(_ file: String) throws -> String {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(contentsOf: root.appending(path: "Sources/CPMenubar/\(file)"), encoding: .utf8)
    }

    func testEveryGitSpawnGoesThroughTheHardenedEnvironment() throws {
        let source = try appSource("WorkerProcess.swift")

        // Every `process.environment = …` in a function that spawns git must be the hardened one.
        // Counted rather than pattern-matched per call, so a new spawn shows up as a mismatch.
        let assignments = source.components(separatedBy: "process.environment = ").count - 1
        let hardened = source.components(separatedBy: "process.environment = GitSafeEnvironment.apply").count - 1
        let spawnsSomethingElse = source.components(separatedBy: "\"gh\", \"auth\"").count - 1
        let launchesTheWorker = source.components(separatedBy: "plan.environment").count - 1

        XCTAssertEqual(
            hardened, assignments - spawnsSomethingElse - launchesTheWorker,
            "a Process here sets an environment that is not GitSafeEnvironment.apply(to:) — if it spawns git, harden it; if it does not, teach this test about it")
    }
}
