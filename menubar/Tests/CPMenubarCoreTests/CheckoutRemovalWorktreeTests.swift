import XCTest
@testable import CPMenubarCore

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

    func testItLooksPastTheFirstWorktree() {
        let (checkout, first) = repoWithWorktree()
        let second = dir + "/cp-worktrees/BP-2"
        _ = git(checkout, ["worktree", "add", "-q", "-b", "bp-2/worker", second])

        FileManager.default.createFile(
            atPath: second + "/unsaved.txt", contents: Data("the second worktree's work\n".utf8))

        guard case .refused(let reason) = removal().check(path: checkout, workerIsBusy: false) else {
            return XCTFail("the dirty worktree is the second one, and it still has to be found")
        }
        XCTAssertTrue(
            reason.contains(resolved(second)), "names the worktree that is actually dirty: \(reason)")
        XCTAssertFalse(reason.contains(resolved(first)), "and not the clean one")
    }

    func testShowToplevelInAWorktreeAnswersWithTheWorktree() {
        let (_, worktree) = repoWithWorktree()

        let toplevel = git(worktree, ["rev-parse", "--show-toplevel"]).output
            .trimmingCharacters(in: .whitespacesAndNewlines)

        XCTAssertEqual(resolved(toplevel), resolved(worktree))
    }

    func testWorktreeListNamesTheMainCheckoutFirstEvenFromAWorktree() {
        let (checkout, worktree) = repoWithWorktree()

        let listing = git(worktree, ["worktree", "list", "--porcelain", "-z"]).output
        let first = listing.split(separator: "\0").first.map(String.init) ?? ""

        XCTAssertTrue(first.hasPrefix("worktree "), "unexpected porcelain shape: \(listing)")
        XCTAssertEqual(
            resolved(String(first.dropFirst("worktree ".count))), resolved(checkout),
            "the whole listing was: \(listing)")
    }

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

    func testItRefusesToRemoveAPathThatIsItselfALinkedWorktree() {
        let (checkout, worktree) = repoWithWorktree()

        let verdict = removal().check(path: worktree, workerIsBusy: false)

        guard case .refused(let reason) = verdict else {
            XCTFail("expected a refusal, got \(verdict) — the repository at \(checkout) would be deleted")
            return
        }
        XCTAssertTrue(
            reason.contains("is a linked worktree"),
            "the refusal has to say what the path is, not just that it is not allowed: \(reason)")
    }

    func testNoVerdictAboutAWorktreeEverNamesTheMainCheckout() {
        let (checkout, worktree) = repoWithWorktree()

        switch removal().check(path: worktree, workerIsBusy: false) {
        case .refused(let reason):
            XCTAssertFalse(
                reason.contains(resolved(checkout)),
                "the refusal names the repository rather than the path it was asked about: \(reason)")
        case .go(let worktrees):
            XCTAssertFalse(
                worktrees.map(resolved).contains(resolved(checkout)),
                "the main checkout is not something unticking a worktree may delete")
        }
    }

    func testItStillAllowsRemovingACheckoutWhoseWorktreesAreClean() {
        let (checkout, worktree) = repoWithWorktree()

        guard case .go(let worktrees) = removal().check(path: checkout, workerIsBusy: false) else {
            XCTFail("a clean checkout with a clean worktree must still be removable")
            return
        }
        XCTAssertEqual(worktrees.count, 1, "the clean worktree is still taken with it")
    }

    func testAWorktreeWhosePathContainsANewlineComesBackWhole() {
        let dir = NSTemporaryDirectory() + "bp427-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let origin = dir + "/origin.git"
        let checkout = dir + "/checkout"
        let odd = dir + "/we\nird"
        _ = git(dir, ["init", "-q", "--bare", origin])
        try? FileManager.default.createDirectory(atPath: checkout, withIntermediateDirectories: true)
        _ = git(checkout, ["init", "-q", "-b", "main"])
        FileManager.default.createFile(atPath: checkout + "/README", contents: Data("hi\n".utf8))
        _ = git(checkout, ["add", "."])
        _ = git(checkout, ["commit", "-qm", "one"])
        _ = git(checkout, ["remote", "add", "origin", origin])
        _ = git(checkout, ["push", "-q", "-u", "origin", "HEAD"])
        _ = git(checkout, ["worktree", "add", "-q", odd, "-b", "odd"])

        guard case .go(let worktrees) = removal().check(path: checkout, workerIsBusy: false) else {
            return XCTFail("expected a go, got \(removal().check(path: checkout, workerIsBusy: false))")
        }

        XCTAssertEqual(
            worktrees.map { ($0 as NSString).standardizingPath },
            [(odd as NSString).standardizingPath],
            "the path arrives with its newline, not cut at it")
    }
}
