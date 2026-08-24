import XCTest
@testable import CPMenubarCore

/// Real git against real repositories. The rest of `CheckoutRemovalTests` stubs `RunGit`, which is
/// the right shape for asserting the guard's own logic — but this file asks a question only git can
/// answer: whether `git status` in a checkout can see uncommitted work that lives in one of its
/// linked worktrees. A stub would answer whatever it was told.
// Free function, not a method: CheckoutRemoval.RunGit is @Sendable, and an XCTestCase is not.
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

final class CheckoutRemovalWorktreeTests: XCTestCase {
    private var dir: String = ""

    private func git(_ cwd: String, _ args: [String]) -> (code: Int32, output: String) {
        realGit(cwd, args)
    }

    private func removal() -> CheckoutRemoval {
        CheckoutRemoval(run: { args, cwd in realGit(cwd, args) })
    }

    override func setUp() {
        super.setUp()
        dir = NSTemporaryDirectory() + "bp418-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: dir)
        super.tearDown()
    }


    /// Everything the other guards want satisfied — a real remote with the commit pushed to it —
    /// so a refusal from `check` can only be about the worktree. The first attempt at this file
    /// skipped the remote and both tests refused for "commits on no remote": a fixture that cannot
    /// isolate the guard under test proves nothing about it.
    private func repoWithWorktree() -> (checkout: String, worktree: String) {
        let origin = dir + "/origin.git"
        let checkout = dir + "/checkout"
        let worktree = dir + "/cp-worktrees/BP-1"
        _ = git(dir, ["init", "-q", "--bare", origin])
        _ = git(dir, ["init", "-q", checkout])
        FileManager.default.createFile(atPath: checkout + "/a.txt", contents: Data("a\n".utf8))
        _ = git(checkout, ["add", "-A"])
        _ = git(checkout, ["commit", "-qm", "initial"])
        _ = git(checkout, ["remote", "add", "origin", origin])
        _ = git(checkout, ["push", "-q", "-u", "origin", "HEAD"])
        _ = git(checkout, ["worktree", "add", "-q", "-b", "bp-1/worker", worktree])
        _ = git(worktree, ["push", "-q", "-u", "origin", "bp-1/worker"])
        return (checkout, worktree)
    }

    /// The premise the whole bug rests on, asserted separately so a failure here is legible as
    /// "git changed" rather than as "the guard changed".
    func testGitStatusInTheCheckoutCannotSeeAWorktreesUncommittedWork() {
        let (checkout, worktree) = repoWithWorktree()

        FileManager.default.createFile(
            atPath: worktree + "/unsaved.txt", contents: Data("a day of work\n".utf8))

        XCTAssertFalse(
            git(worktree, ["status", "--porcelain"]).output.isEmpty,
            "the worktree itself must see its own uncommitted file, or the fixture is wrong")
        XCTAssertTrue(
            git(checkout, ["status", "--porcelain"]).output.isEmpty,
            "this is the premise: the checkout's status is blind to the worktree's working tree")
    }

    /// The bug. The guard is asked about the checkout, says go, and hands back the worktree that is
    /// about to be deleted with a day's uncommitted work in it.
    func testItRefusesWhenALinkedWorktreeHasUncommittedWork() {
        let (checkout, worktree) = repoWithWorktree()
        FileManager.default.createFile(
            atPath: worktree + "/unsaved.txt", contents: Data("a day of work\n".utf8))

        let verdict = removal().check(path: checkout, workerIsBusy: false)

        guard case .refused(let reason) = verdict else {
            XCTFail("expected a refusal, got \(verdict) — the worktree and its unsaved file would be deleted")
            return
        }
        XCTAssertTrue(
            reason.contains(worktree),
            "the refusal has to name the worktree the operator never chose: \(reason)")
    }


    /// The guard has to look at every worktree, not the first one. A machine that works this
    /// repository's way has one per task, so "checks the first" and "checks them all" differ by
    /// exactly the work that gets deleted.
    func testItLooksPastTheFirstWorktree() {
        let (checkout, first) = repoWithWorktree()
        let second = dir + "/cp-worktrees/BP-2"
        _ = git(checkout, ["worktree", "add", "-q", "-b", "bp-2/worker", second])
        _ = git(second, ["push", "-q", "-u", "origin", "bp-2/worker"])

        // The first stays clean on purpose: a guard that stopped after it would say go.
        FileManager.default.createFile(
            atPath: second + "/unsaved.txt", contents: Data("the second worktree's work\n".utf8))

        guard case .refused(let reason) = removal().check(path: checkout, workerIsBusy: false) else {
            return XCTFail("the dirty worktree is the second one, and it still has to be found")
        }
        XCTAssertTrue(reason.contains(second), "names the worktree that is actually dirty: \(reason)")
        XCTAssertFalse(reason.contains(first), "and not the clean one")
    }

    /// The control. Without it, a guard that refused everything would pass the test above and this
    /// file would prove nothing.
    func testItStillAllowsRemovingACheckoutWhoseWorktreesAreClean() {
        let (checkout, worktree) = repoWithWorktree()

        guard case .go(let worktrees) = removal().check(path: checkout, workerIsBusy: false) else {
            XCTFail("a clean checkout with a clean worktree must still be removable")
            return
        }
        XCTAssertEqual(worktrees.count, 1, "the clean worktree is still taken with it")
    }
}
