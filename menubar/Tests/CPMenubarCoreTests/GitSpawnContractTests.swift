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
        let spawnsSomethingElse = source.components(separatedBy: ".gh, [\"auth\"").count - 1
        let launchesTheWorker = source.components(separatedBy: "plan.environment").count - 1

        XCTAssertEqual(
            hardened, assignments - spawnsSomethingElse - launchesTheWorker,
            "a Process here sets an environment that is not GitSafeEnvironment.apply(to:) — if it spawns git, harden it; if it does not, teach this test about it")
    }

    // BP-733. `/usr/bin/env git` finds git on the PATH this app hands its children, so anything
    // earlier on it would become git — or become the gh that is handed the pinned account's token.
    func testNoToolIsSpawnedByNameThroughEnv() throws {
        let source = try appSource("WorkerProcess.swift")

        XCTAssertFalse(source.contains("/usr/bin/env"), "a child is looked up by name on PATH")
        let spawns = source.components(separatedBy: "Process()").count - 1
        let byResolvedPath = source.components(
            separatedBy: "process.executableURL = URL(fileURLWithPath: command.executable)").count - 1
        // The worker's own launch, from WorkerLauncher.plan, and runCapturing, which launches the
        // node resolveNode found — the two spawns that are not git or gh
        XCTAssertEqual(
            byResolvedPath, spawns - 2,
            "a Process here runs git or gh without ToolCommand.make — or a new spawn needs teaching to this test")
        XCTAssertEqual(byResolvedPath, 3, "cloneStep, git and githubToken each spawn by the resolved path")
    }
}
