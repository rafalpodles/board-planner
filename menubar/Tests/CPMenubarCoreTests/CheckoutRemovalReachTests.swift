import XCTest
@testable import CPMenubarCore

@Sendable private func reachGit(_ cwd: String, _ args: [String]) -> (code: Int32, output: String) {
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
    do {
        try task.run()
    } catch {
        return (127, "could not run git: \(error.localizedDescription)")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    return (task.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

final class CheckoutRemovalReachTests: XCTestCase {
    private var dir = ""

    override func setUp() {
        super.setUp()
        dir = NSTemporaryDirectory() + "bp423-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: dir)
        super.tearDown()
    }

    private func git(_ cwd: String, _ args: [String]) -> (code: Int32, output: String) {
        reachGit(cwd, args)
    }

    private func removal() -> CheckoutRemoval {
        CheckoutRemoval(run: { args, cwd in reachGit(cwd, args) })
    }

    @discardableResult
    private func cleanCheckout(_ name: String = "checkout") -> String {
        let origin = dir + "/\(name)-origin.git"
        let checkout = dir + "/\(name)"
        _ = git(dir, ["init", "-q", "--bare", origin])
        _ = git(dir, ["init", "-q", "-b", "main", checkout])
        FileManager.default.createFile(atPath: checkout + "/a.txt", contents: Data("a\n".utf8))
        _ = git(checkout, ["add", "-A"])
        _ = git(checkout, ["commit", "-qm", "initial"])
        _ = git(checkout, ["remote", "add", "origin", origin])
        _ = git(checkout, ["push", "-q", "-u", "origin", "HEAD"])
        return checkout
    }

    private func verdict(_ path: String) -> RemovalVerdict {
        removal().check(path: path, workerIsBusy: false)
    }

    private func refusal(_ path: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        guard case .refused(let reason) = verdict(path) else {
            XCTFail("expected a refusal, got \(verdict(path))", file: file, line: line)
            return ""
        }
        return reason
    }

    func testAGenuinelyCleanCheckoutIsStillRemovable() {
        let checkout = cleanCheckout()

        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

    func testOrdinaryIgnoredFilesDoNotStopARemoval() {
        let checkout = cleanCheckout()
        FileManager.default.createFile(
            atPath: checkout + "/.gitignore", contents: Data(".env\nbuild/\n".utf8))
        _ = git(checkout, ["add", "-A"])
        _ = git(checkout, ["commit", "-qm", "ignore"])
        _ = git(checkout, ["push", "-q"])
        FileManager.default.createFile(atPath: checkout + "/.env", contents: Data("SECRET=1\n".utf8))
        try? FileManager.default.createDirectory(
            atPath: checkout + "/build", withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: checkout + "/build/out.o", contents: Data("x".utf8))

        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

    func testACommitOnADetachedHeadIsNotInvisible() {
        let checkout = cleanCheckout()
        _ = git(checkout, ["checkout", "-q", "--detach"])
        FileManager.default.createFile(atPath: checkout + "/b.txt", contents: Data("b\n".utf8))
        _ = git(checkout, ["add", "-A"])
        _ = git(checkout, ["commit", "-qm", "work nobody named"])

        XCTAssertTrue(
            git(checkout, ["log", "--branches", "--not", "--remotes", "--oneline"]).output.isEmpty,
            "--branches is what made this invisible")

        XCTAssertTrue(refusal(checkout).contains("on no remote"), refusal(checkout))
    }

    func testAStashIsStillReportedAsAStash() {
        let checkout = cleanCheckout()
        FileManager.default.createFile(atPath: checkout + "/a.txt", contents: Data("changed\n".utf8))
        _ = git(checkout, ["stash", "-q"])

        XCTAssertTrue(refusal(checkout).contains("stashed"), refusal(checkout))
    }

    func testASubmoduleItsOwnGitmodulesSilencedIsStillSeen() throws {
        let checkout = cleanCheckout()
        let subOrigin = dir + "/sub-origin.git"
        _ = git(dir, ["init", "-q", "--bare", subOrigin])
        let subSource = dir + "/sub-source"
        _ = git(dir, ["init", "-q", "-b", "main", subSource])
        FileManager.default.createFile(atPath: subSource + "/s.txt", contents: Data("s\n".utf8))
        _ = git(subSource, ["add", "-A"])
        _ = git(subSource, ["commit", "-qm", "sub"])
        _ = git(subSource, ["remote", "add", "origin", subOrigin])
        _ = git(subSource, ["push", "-q", "-u", "origin", "HEAD"])

        _ = git(checkout, ["-c", "protocol.file.allow=always", "submodule", "-q", "add", subOrigin, "sub"])
        _ = git(checkout, ["config", "-f", ".gitmodules", "submodule.sub.ignore", "all"])
        _ = git(checkout, ["add", "-A"])
        _ = git(checkout, ["commit", "-qm", "vendor it, and tell git to look away"])
        _ = git(checkout, ["push", "-q"])
        try XCTSkipIf(
            !FileManager.default.fileExists(atPath: checkout + "/sub/s.txt"),
            "this git refused a file-protocol submodule; the guard is covered by the control below")

        FileManager.default.createFile(
            atPath: checkout + "/sub/s.txt", contents: Data("a day of work\n".utf8))

        XCTAssertTrue(
            git(checkout, ["status", "--porcelain"]).output.isEmpty,
            "the premise: its own .gitmodules made the parent report clean")

        XCTAssertFalse(refusal(checkout).isEmpty)
    }

    func testACleanSubmoduleSilencedTheSameWayStillGoes() throws {
        let checkout = cleanCheckout()
        let subOrigin = dir + "/sub2-origin.git"
        _ = git(dir, ["init", "-q", "--bare", subOrigin])
        let subSource = dir + "/sub2-source"
        _ = git(dir, ["init", "-q", "-b", "main", subSource])
        FileManager.default.createFile(atPath: subSource + "/s.txt", contents: Data("s\n".utf8))
        _ = git(subSource, ["add", "-A"])
        _ = git(subSource, ["commit", "-qm", "sub"])
        _ = git(subSource, ["remote", "add", "origin", subOrigin])
        _ = git(subSource, ["push", "-q", "-u", "origin", "HEAD"])

        _ = git(checkout, ["-c", "protocol.file.allow=always", "submodule", "-q", "add", subOrigin, "sub"])
        _ = git(checkout, ["config", "-f", ".gitmodules", "submodule.sub.ignore", "all"])
        _ = git(checkout, ["add", "-A"])
        _ = git(checkout, ["commit", "-qm", "vendor it"])
        _ = git(checkout, ["push", "-q"])
        try XCTSkipIf(
            !FileManager.default.fileExists(atPath: checkout + "/sub/s.txt"),
            "this git refused a file-protocol submodule")

        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

    func testALockedWorktreeIsHonouredRatherThanDeleted() {
        let checkout = cleanCheckout()
        let worktree = dir + "/cp-worktrees/BP-1"
        _ = git(checkout, ["worktree", "add", "-q", "-b", "bp-1/worker", worktree])
        _ = git(checkout, ["worktree", "lock", "--reason", "on the external drive - do not touch", worktree])

        let reason = refusal(checkout)

        XCTAssertTrue(reason.contains("locked"), reason)
        XCTAssertTrue(reason.contains("external drive"), reason)
    }

    func testALockWithNoReasonIsStillALock() {
        let checkout = cleanCheckout()
        let worktree = dir + "/cp-worktrees/BP-2"
        _ = git(checkout, ["worktree", "add", "-q", "-b", "bp-2/worker", worktree])
        _ = git(checkout, ["worktree", "lock", worktree])

        XCTAssertTrue(refusal(checkout).contains("locked"), refusal(checkout))
    }

    func testAnUnlockedWorktreeStillGoes() {
        let checkout = cleanCheckout()
        let worktree = dir + "/cp-worktrees/BP-3"
        _ = git(checkout, ["worktree", "add", "-q", "-b", "bp-3/worker", worktree])
        _ = git(checkout, ["worktree", "lock", worktree])
        _ = git(checkout, ["worktree", "unlock", worktree])

        XCTAssertEqual(
            verdict(checkout).goWorktrees?.map { ($0 as NSString).resolvingSymlinksInPath },
            [(worktree as NSString).resolvingSymlinksInPath])
    }

    private func nestedRepo(in checkout: String, at relative: String) -> String {
        FileManager.default.createFile(
            atPath: checkout + "/.gitignore", contents: Data("\(relative)\n".utf8))
        _ = git(checkout, ["add", "-A"])
        _ = git(checkout, ["commit", "-qm", "ignore it"])
        _ = git(checkout, ["push", "-q"])

        let nested = checkout + "/" + relative
        try? FileManager.default.createDirectory(atPath: nested, withIntermediateDirectories: true)
        _ = git(nested, ["init", "-q", "-b", "main", "."])
        return nested
    }

    func testARepositoryInAnIgnoredDirectoryWithUnpushedWorkRefuses() {
        let checkout = cleanCheckout()
        let nested = nestedRepo(in: checkout, at: "thesis")
        FileManager.default.createFile(
            atPath: nested + "/chapter.md", contents: Data("years of it\n".utf8))
        _ = git(nested, ["add", "-A"])
        _ = git(nested, ["commit", "-qm", "chapter one"])

        XCTAssertTrue(
            git(checkout, ["status", "--porcelain"]).output.isEmpty,
            "the premise: the parent reports clean")

        let reason = refusal(checkout)
        XCTAssertTrue(reason.contains("separate repository"), reason)
    }

    func testARepositoryInAnIgnoredDirectoryWithUncommittedWorkRefuses() {
        let checkout = cleanCheckout()
        let nested = nestedRepo(in: checkout, at: "thesis")
        FileManager.default.createFile(atPath: nested + "/draft.md", contents: Data("unsaved\n".utf8))

        XCTAssertTrue(refusal(checkout).contains("separate repository"), refusal(checkout))
    }

    func testARepositoryInAnIgnoredDirectoryWhoseWorkIsPushedStillGoes() {
        let checkout = cleanCheckout()
        let nested = nestedRepo(in: checkout, at: "thesis")
        let nestedOrigin = dir + "/thesis-origin.git"
        _ = git(dir, ["init", "-q", "--bare", nestedOrigin])
        FileManager.default.createFile(atPath: nested + "/chapter.md", contents: Data("one\n".utf8))
        _ = git(nested, ["add", "-A"])
        _ = git(nested, ["commit", "-qm", "chapter one"])
        _ = git(nested, ["remote", "add", "origin", nestedOrigin])
        _ = git(nested, ["push", "-q", "-u", "origin", "HEAD"])

        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

    func testAPrefetchRefDoesNotMakeACleanCheckoutRefuse() {
        let checkout = cleanCheckout()
        let origin = dir + "/checkout-origin.git"

        _ = git(checkout, ["checkout", "-q", "-b", "prefetched"])
        FileManager.default.createFile(atPath: checkout + "/b.txt", contents: Data("b\n".utf8))
        _ = git(checkout, ["add", "-A"])
        _ = git(checkout, ["commit", "-qm", "theirs, arriving by prefetch"])
        let prefetched = git(checkout, ["rev-parse", "HEAD"]).output
            .trimmingCharacters(in: .whitespacesAndNewlines)
        _ = git(checkout, ["checkout", "-q", "main"])
        _ = git(checkout, ["branch", "-qD", "prefetched"])
        _ = git(checkout, ["update-ref", "refs/prefetch/remotes/origin/main", prefetched])
        _ = origin

        XCTAssertFalse(
            git(checkout, ["log", "--all", "--not", "--remotes", "--oneline"]).output.isEmpty,
            "the premise: a bare --all counts the prefetched commit as unpushed")

        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

    func testAGitNoteDoesNotMakeACleanCheckoutRefuse() {
        let checkout = cleanCheckout()
        _ = git(checkout, ["notes", "add", "-m", "reviewed by hand"])

        XCTAssertTrue(
            git(checkout, ["notes", "list"]).code == 0,
            "the premise: this git supports notes")
        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

    func testATagOnAPushedCommitStillGoes() {
        let checkout = cleanCheckout()
        _ = git(checkout, ["tag", "v1"])
        _ = git(checkout, ["tag", "-a", "v2", "-m", "annotated"])

        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

    func testANestedRepositoryUnderAQuotedDirectoryIsSeen() {
        let checkout = cleanCheckout()
        let nested = nestedRepo(in: checkout, at: "my scratch")
        FileManager.default.createFile(
            atPath: nested + "/draft.md", contents: Data("unsaved\n".utf8))

        XCTAssertTrue(refusal(checkout).contains("separate repository"), refusal(checkout))
    }

    func testALockedWorktreeOnAnUnmountedVolumeIsStillHonoured() {
        let checkout = cleanCheckout()
        let worktree = dir + "/cp-worktrees/BP-4"
        _ = git(checkout, ["worktree", "add", "-q", "-b", "bp-4/worker", worktree])
        _ = git(checkout, ["worktree", "lock", "--reason", "on the external drive", worktree])
        try? FileManager.default.removeItem(atPath: worktree)

        let reason = refusal(checkout)
        XCTAssertTrue(reason.contains("locked"), reason)
        XCTAssertTrue(reason.contains("external drive"), reason)
    }

    func testAPrefetchRefInsideANestedRepositoryDoesNotRefuseTheParent() {
        let checkout = cleanCheckout()
        let nested = nestedRepo(in: checkout, at: "thesis")
        let nestedOrigin = dir + "/thesis-origin.git"
        _ = git(dir, ["init", "-q", "--bare", nestedOrigin])
        FileManager.default.createFile(atPath: nested + "/chapter.md", contents: Data("one\n".utf8))
        _ = git(nested, ["add", "-A"])
        _ = git(nested, ["commit", "-qm", "chapter one"])
        _ = git(nested, ["remote", "add", "origin", nestedOrigin])
        _ = git(nested, ["push", "-q", "-u", "origin", "HEAD"])

        _ = git(nested, ["checkout", "-q", "-b", "prefetched"])
        _ = git(nested, ["commit", "-q", "--allow-empty", "-m", "arriving by prefetch"])
        let sha = git(nested, ["rev-parse", "HEAD"]).output
            .trimmingCharacters(in: .whitespacesAndNewlines)
        _ = git(nested, ["checkout", "-q", "main"])
        _ = git(nested, ["branch", "-qD", "prefetched"])
        _ = git(nested, ["update-ref", "refs/prefetch/remotes/origin/main", sha])

        XCTAssertFalse(
            git(nested, ["log", "--all", "--not", "--remotes", "--oneline"]).output.isEmpty,
            "the premise: a bare --all inside the nested repository counts it as unpushed")

        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

    func testANoteInsideANestedRepositoryDoesNotRefuseTheParent() {
        let checkout = cleanCheckout()
        let nested = nestedRepo(in: checkout, at: "thesis")
        let nestedOrigin = dir + "/thesis-origin.git"
        _ = git(dir, ["init", "-q", "--bare", nestedOrigin])
        FileManager.default.createFile(atPath: nested + "/chapter.md", contents: Data("one\n".utf8))
        _ = git(nested, ["add", "-A"])
        _ = git(nested, ["commit", "-qm", "chapter one"])
        _ = git(nested, ["remote", "add", "origin", nestedOrigin])
        _ = git(nested, ["push", "-q", "-u", "origin", "HEAD"])
        _ = git(nested, ["notes", "add", "-m", "read this first"])

        XCTAssertEqual(verdict(checkout), .go(worktrees: []))
    }

}

private extension RemovalVerdict {
    var goWorktrees: [String]? {
        if case .go(let worktrees) = self { return worktrees }
        return nil
    }
}