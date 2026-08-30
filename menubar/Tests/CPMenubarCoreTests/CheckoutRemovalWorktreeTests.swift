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
    /// git reports `/private/var/…` where NSTemporaryDirectory gives `/var/…`, so an unresolved
    /// comparison passes on a substring and reads stricter than it is.
    private func resolved(_ path: String) -> String {
        (path as NSString).resolvingSymlinksInPath
    }

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
            reason.contains(resolved(worktree)),
            "the refusal has to name the worktree the operator never chose: \(reason)")
    }


    /// The guard has to look at every worktree, not the first one. A machine that works this
    /// repository's way has one per task, so "checks the first" and "checks them all" differ by
    /// exactly the work that gets deleted.
    func testItLooksPastTheFirstWorktree() {
        let (checkout, first) = repoWithWorktree()
        let second = dir + "/cp-worktrees/BP-2"
        _ = git(checkout, ["worktree", "add", "-q", "-b", "bp-2/worker", second])

        // The first stays clean on purpose: a guard that stopped after it would say go.
        FileManager.default.createFile(
            atPath: second + "/unsaved.txt", contents: Data("the second worktree's work\n".utf8))

        guard case .refused(let reason) = removal().check(path: checkout, workerIsBusy: false) else {
            return XCTFail("the dirty worktree is the second one, and it still has to be found")
        }
        XCTAssertTrue(
            reason.contains(resolved(second)), "names the worktree that is actually dirty: \(reason)")
        XCTAssertFalse(reason.contains(resolved(first)), "and not the clean one")
    }

    // MARK: - BP-422: the granted path is itself a linked worktree

    /// Premise one. This is why the subdirectory guard cannot see the case: a linked worktree is a
    /// work tree, and `--show-toplevel` answers with the worktree's own path, so the comparison
    /// against the granted path succeeds on a checkout looking at itself.
    func testShowToplevelInAWorktreeAnswersWithTheWorktree() {
        let (_, worktree) = repoWithWorktree()

        let toplevel = git(worktree, ["rev-parse", "--show-toplevel"]).output
            .trimmingCharacters(in: .whitespacesAndNewlines)

        XCTAssertEqual(resolved(toplevel), resolved(worktree))
    }

    /// Premise two. `git worktree list` names the repository's main checkout first, whichever
    /// worktree it is run from — which is what put the repository at the top of the deletion list.
    /// Asserted separately so a failure here reads as "git changed", not "the guard changed".
    func testWorktreeListNamesTheMainCheckoutFirstEvenFromAWorktree() {
        let (checkout, worktree) = repoWithWorktree()

        let listing = git(worktree, ["worktree", "list", "--porcelain"]).output
        let first = listing.split(separator: "\n").first.map(String.init) ?? ""

        XCTAssertTrue(first.hasPrefix("worktree "), "unexpected porcelain shape: \(listing)")
        XCTAssertEqual(
            resolved(String(first.dropFirst("worktree ".count))), resolved(checkout),
            "the whole listing was: \(listing)")
    }

    /// Premise three, and the discriminator the fix rests on: the two answers agree in a repository
    /// and differ in a worktree. `CloneStep` reads the same pair.
    func testGitDirAndCommonDirTellARepositoryFromItsWorktree() {
        let (checkout, worktree) = repoWithWorktree()

        func kind(_ path: String) -> GitCheckoutKind? {
            LinkedWorktreeCheck.kind(
                gitDir: git(path, ["rev-parse", "--git-dir"]),
                commonDir: git(path, ["rev-parse", "--git-common-dir"]),
                relativeTo: path)
        }

        XCTAssertEqual(kind(checkout), .repository)
        XCTAssertEqual(kind(worktree), .linkedWorktree)
    }

    /// The bug. `repos.json` holds the worktree, the operator unticks the project, and the list
    /// handed back for deletion opens with the repository nobody named — whose `.git` holds the
    /// object store every other worktree of it shares.
    func testItRefusesToRemoveAPathThatIsItselfALinkedWorktree() {
        let (checkout, worktree) = repoWithWorktree()

        let verdict = removal().check(path: worktree, workerIsBusy: false)

        guard case .refused(let reason) = verdict else {
            XCTFail("expected a refusal, got \(verdict) — the repository at \(checkout) would be deleted")
            return
        }
        // Not `contains("worktree")`: every neighbouring refusal in this file says that word too —
        // "one of its worktrees", "could not list the worktrees of" — so it would pass for a guard
        // that had stopped telling the two apart (BP-422 review)
        XCTAssertTrue(
            reason.contains("is a linked worktree"),
            "the refusal has to say what the path is, not just that it is not allowed: \(reason)")
    }

    /// Belt and braces, and the second half of the ticket: whatever the verdict, the list of things
    /// to delete may never contain a repository's main checkout.
    ///
    /// Written as a switch with no silent arm on purpose. The first version was `if case .go`, and
    /// against this branch `check` refuses — so the body never ran and the test executed no
    /// assertion at all while reading like a guard (BP-422 review).
    func testNoVerdictAboutAWorktreeEverNamesTheMainCheckout() {
        let (checkout, worktree) = repoWithWorktree()

        switch removal().check(path: worktree, workerIsBusy: false) {
        case .refused:
            break
        case .go(let worktrees):
            XCTAssertFalse(
                worktrees.map(resolved).contains(resolved(checkout)),
                "the main checkout is not something unticking a worktree may delete")
        }
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
