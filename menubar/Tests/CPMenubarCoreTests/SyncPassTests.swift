import XCTest
@testable import CPMenubarCore

/// BP-424. A pass clones first and deletes second, and `busy` used to be one value sampled before
/// either. A clone takes minutes, so a worker idle when the pass began and running by the time the
/// deletions were reached had its checkout removed underneath it.
///
/// These drive the whole pass, so the thing under test is the ordering rather than any one guard.
/// Real git and a real directory for the case that ends in a deletion — a stub would answer
/// whatever it was told, and what needs proving is that a directory does or does not survive.
@Sendable private func realGit(_ cwd: String, _ args: [String]) -> (code: Int32, output: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = ["git"] + args
    task.currentDirectoryURL = URL(fileURLWithPath: cwd)
    task.environment = [
        "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
    ]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = pipe
    try? task.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    return (task.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

@MainActor
final class SyncPassTests: XCTestCase {
    private var root = ""

    override func setUpWithError() throws {
        root = NSTemporaryDirectory() + "bp424-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: root)
    }

    // MARK: - the world

    /// A checkout every other guard is happy with — committed, and pushed to a real remote.
    /// Without the remote, `CheckoutRemoval` refuses for "commits on no remote" and the controls
    /// below assert a refusal while believing they assert a deletion. CheckoutRemovalWorktreeTests
    /// carries the same warning; I walked into it anyway.
    private func checkout(_ name: String) throws -> String {
        let path = root + "/" + name
        let origin = root + "/" + name + ".git"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        _ = realGit(root, ["init", "-q", "--bare", origin])
        _ = realGit(path, ["init", "-q", "-b", "main"])
        FileManager.default.createFile(atPath: path + "/README", contents: Data("hi\n".utf8))
        _ = realGit(path, ["add", "."])
        _ = realGit(path, ["commit", "-qm", "one"])
        _ = realGit(path, ["remote", "add", "origin", origin])
        _ = realGit(path, ["push", "-q", "-u", "origin", "HEAD"])
        return path
    }

    // No name, so `label` is the key alone and the assertions read as the key rather than "NEW · NEW"
    private func offer(_ key: String) -> ProjectOffer {
        ProjectOffer(project: key, key: key, name: "", repositoryUrl: "https://example.test/\(key).git")
    }

    private final class Grants: @unchecked Sendable {
        var forgotten: [String] = []
    }

    private func deletion(_ grants: Grants) -> CheckoutDeletion {
        CheckoutDeletion(
            remove: { try FileManager.default.removeItem(atPath: $0) },
            exists: { FileManager.default.fileExists(atPath: $0) },
            forget: { grants.forgotten.append($0) })
    }

    private var removal: CheckoutRemoval {
        CheckoutRemoval(run: { args, cwd in realGit(cwd, args) })
    }

    // MARK: - the bug

    func testAWorkerThatBecomesBusyDuringTheCloneKeepsItsCheckout() async throws {
        let path = try checkout("held")
        let grants = Grants()
        var busy = false
        var steps: [SyncStep] = []

        await SyncPass.run(
            plan: SyncPlan(
                add: [offer("NEW")],
                remove: [PlannedRemoval(project: offer("OLD"), path: path)]),
            // The clone is where the minutes go, and where the worker picks up a task.
            add: { _ in
                busy = true
                return .success("\(self.root)/new")
            },
            isBusy: { busy },
            deletion: deletion(grants),
            removal: removal,
            asking: { _, _ in true },
            onStep: { steps.append($0) })

        XCTAssertEqual(
            steps,
            [
                .added(project: "NEW", path: root + "/new"),
                .refused(
                    project: "OLD",
                    reason: "the worker is running a task — stop it, or wait for it to finish"),
            ])
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: path),
            "the checkout is still on disk — this is the whole ticket")
        XCTAssertEqual(grants.forgotten, [], "and it still has its grant")
    }

    /// The one that separates "read once before the removals" from "read before each removal".
    /// A fix that sampled once after the clones would pass everything above and fail here.
    func testTheQuestionIsAskedAgainBetweenTwoRemovals() async throws {
        let first = try checkout("first")
        let second = try checkout("second")
        let grants = Grants()
        var asked = 0
        var steps: [SyncStep] = []

        await SyncPass.run(
            plan: SyncPlan(
                add: [],
                remove: [
                    PlannedRemoval(project: offer("ONE"), path: first),
                    PlannedRemoval(project: offer("TWO"), path: second),
                ]),
            add: { _ in .success("") },
            // Idle through the first removal, running by the time the second is reached: a removal
            // takes time too. Two questions per removal since BP-378 — the guards ask, and the
            // confirmation asks again after the operator has answered — so this flips on the third.
            isBusy: {
                defer { asked += 1 }
                return asked >= 2
            },
            deletion: deletion(grants),
            removal: removal,
            asking: { _, _ in true },
            onStep: { steps.append($0) })

        XCTAssertEqual(steps.first, .removed(project: "ONE", path: first))
        XCTAssertEqual(
            steps.last,
            .refused(
                project: "TWO",
                reason: "the worker is running a task — stop it, or wait for it to finish"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: first), "the first one went")
        XCTAssertTrue(FileManager.default.fileExists(atPath: second), "the second one stayed")
    }

    // MARK: - the controls

    func testAnIdleWorkerThroughoutStillGetsItsRemoval() async throws {
        let path = try checkout("stale")
        let grants = Grants()
        var steps: [SyncStep] = []

        await SyncPass.run(
            plan: SyncPlan(
                add: [offer("NEW")],
                remove: [PlannedRemoval(project: offer("OLD"), path: path)]),
            add: { _ in .success("\(self.root)/new") },
            isBusy: { false },
            deletion: deletion(grants),
            removal: removal,
            asking: { _, _ in true },
            onStep: { steps.append($0) })

        XCTAssertEqual(
            steps,
            [.added(project: "NEW", path: root + "/new"), .removed(project: "OLD", path: path)])
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        XCTAssertEqual(grants.forgotten, [path])
    }

    // MARK: - BP-378: the whole pass, against a real directory, when the operator says no

    /// The seam is asserted in CheckoutDeletionTests against a recorder. This is the same question
    /// put through the pass at a directory that really exists, because what the criterion is about
    /// is whether it is still there afterwards.
    func testADeclinedRemovalLeavesTheCheckoutOnDisk() async throws {
        let path = try checkout("kept")
        let grants = Grants()
        var asked: [[String]] = []
        var steps: [SyncStep] = []

        await SyncPass.run(
            plan: SyncPlan(add: [], remove: [PlannedRemoval(project: offer("OLD"), path: path)]),
            add: { _ in .success("") },
            isBusy: { false },
            deletion: deletion(grants),
            removal: removal,
            asking: { _, paths in
                asked.append(paths)
                return false
            },
            onStep: { steps.append($0) })

        XCTAssertEqual(asked, [[path]], "asked by path, and only about what is there")
        XCTAssertEqual(steps, [.declined(project: "OLD", paths: [path])])
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "it is still there — the point")
        XCTAssertEqual(grants.forgotten, [], "and still granted, so the unticking stands and it asks again")
    }

    func testAPassWithNoClonesBehavesAsItDid() async throws {
        let path = try checkout("stale")
        let grants = Grants()
        var asked = 0
        var steps: [SyncStep] = []

        await SyncPass.run(
            plan: SyncPlan(add: [], remove: [PlannedRemoval(project: offer("OLD"), path: path)]),
            add: { _ in XCTFail("nothing to add"); return .success("") },
            isBusy: {
                asked += 1
                return false
            },
            deletion: deletion(grants),
            removal: removal,
            asking: { _, _ in true },
            onStep: { steps.append($0) })

        XCTAssertEqual(steps, [.removed(project: "OLD", path: path)])
        XCTAssertEqual(
            asked, 2,
            "twice for the one removal: once for the guards, once after the operator answered — the confirmation is the longer of the two windows (BP-378)")
    }

    func testAWorkerBusyFromTheStartIsRefusedAsBefore() async throws {
        let path = try checkout("held")
        let grants = Grants()
        var steps: [SyncStep] = []

        await SyncPass.run(
            plan: SyncPlan(add: [], remove: [PlannedRemoval(project: offer("OLD"), path: path)]),
            add: { _ in .success("") },
            isBusy: { true },
            deletion: deletion(grants),
            removal: removal,
            asking: { _, _ in true },
            onStep: { steps.append($0) })

        // The step, not just the count: a `.failed` would also be one step, and would also leave
        // the directory where it is.
        XCTAssertEqual(
            steps,
            [
                .refused(
                    project: "OLD",
                    reason: "the worker is running a task — stop it, or wait for it to finish")
            ])
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    }

    func testAFailedCloneIsReportedAndTheRemovalsStillRun() async throws {
        let path = try checkout("stale")
        let grants = Grants()
        var steps: [SyncStep] = []

        await SyncPass.run(
            plan: SyncPlan(
                add: [offer("NEW")],
                remove: [PlannedRemoval(project: offer("OLD"), path: path)]),
            add: { _ in .failure(.clone(reason: "no network")) },
            isBusy: { false },
            deletion: deletion(grants),
            removal: removal,
            asking: { _, _ in true },
            onStep: { steps.append($0) })

        XCTAssertEqual(
            steps,
            [
                .failed(project: "NEW", reason: "no network"),
                .removed(project: "OLD", path: path),
            ])
    }

    // MARK: - the question that cannot be answered

    func testASocketThatWillNotAnswerCountsAsBusy() async {
        struct Down: Error {}
        let isBusy = SyncPass.busy(asking: { throw Down() })

        let answer = await isBusy()

        XCTAssertTrue(answer, "not knowing is not the same as knowing it is idle")
    }

    func testAnIdleAnswerIsNotBusy_andARunningOneIs() async {
        let idle = SyncPass.busy(asking: { StatusResponse(paused: false, current: nil, recent: []) })
        let running = SyncPass.busy(
            asking: {
                StatusResponse(
                    paused: false,
                    current: Progress(phase: "working", taskKey: "BP-1"),
                    recent: [])
            })

        let idleAnswer = await idle()
        let runningAnswer = await running()

        XCTAssertFalse(idleAnswer)
        XCTAssertTrue(runningAnswer)
    }
}
