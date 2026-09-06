import XCTest
@testable import CPMenubarCore

func porcelainZ(_ readable: String) -> String {
    readable
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .joined(separator: "\0") + "\0"
}

final class CheckoutRemovalTests: XCTestCase {
    private final class Git: @unchecked Sendable {
        var answers: [String: (Int32, String)] = [:]
        var present: Set<String> = ["/checkouts/SB"]
        var calls: [[String]] = []

        func removal() -> CheckoutRemoval {
            CheckoutRemoval(
                run: { args, _ in
                    self.calls.append(args)
                    for (needle, answer) in self.answers where args.contains(needle) { return answer }
                    if args.contains("--show-toplevel") { return (0, "/checkouts/SB\n") }
                    if args.contains("--git-dir") || args.contains("--git-common-dir") {
                        return (0, ".git")
                    }
                    if args.contains("--porcelain") && args.contains("worktree") {
                        return (0, porcelainZ("worktree /checkouts/SB\nHEAD abc"))
                    }
                    return (0, "")
                },
                exists: { self.present.contains($0) })
        }
    }

    func testItAllowsRemovingACleanCheckout() {
        XCTAssertEqual(Git().removal().check(path: "/checkouts/SB", workerIsBusy: false), .go(worktrees: []))
    }

    func testItRefusesWhileTheWorkerIsWorking() {
        let verdict = Git().removal().check(path: "/checkouts/SB", workerIsBusy: true)

        guard case .refused(let reason) = verdict else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("running a task"))
    }

    func testItRefusesACheckoutWithUncommittedChanges() {
        let git = Git()
        git.answers["--porcelain"] = (0, " M src/a.ts\n?? new.ts\n")

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        guard case .refused(let reason) = verdict else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("2 uncommitted changes"), reason)
    }

    func testItRefusesCommitsThatAreOnNoRemote() {
        let git = Git()
        git.answers["--not"] = (0, "abc1234 wip\ndef5678 more wip\n")

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        guard case .refused(let reason) = verdict else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("2 commits"), reason)
        XCTAssertTrue(reason.contains("no remote"), reason)
    }

    func testItRefusesACheckoutWithAStash() {
        let git = Git()
        git.answers["stash"] = (0, "stash@{0}: WIP on main: abc123\n")

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        guard case .refused(let reason) = verdict else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("stashed"), reason)
    }

    func testEveryCheckThatCannotRunIsARefusal() {
        for failing in ["--show-toplevel", "--porcelain", "--not", "stash", "worktree"] {
            let git = Git()
            git.answers[failing] = (128, "fatal: not a git repository")

            let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

            guard case .refused = verdict else {
                return XCTFail("a failing `\(failing)` was treated as permission to delete")
            }
        }
    }

    func testItRefusesASubdirectoryOfACheckout() {
        let git = Git()
        git.present = ["/checkouts/SB/src"]
        git.answers["--show-toplevel"] = (0, "/checkouts/SB\n")

        let verdict = git.removal().check(path: "/checkouts/SB/src", workerIsBusy: false)

        guard case .refused(let reason) = verdict else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("inside the checkout"), reason)
    }

    func testItNamesTheLinkedWorktreesToTakeWithIt() {
        let git = Git()
        git.present = ["/checkouts/SB", "/checkouts/cp-worktrees/w1/bp-1", "/checkouts/cp-worktrees/w1/bp-2"]
        git.answers["worktree"] = (
            0,
            porcelainZ(
            """
            worktree /checkouts/SB
            HEAD abc

            worktree /checkouts/cp-worktrees/w1/bp-1
            HEAD def

            worktree /checkouts/cp-worktrees/w1/bp-2
            HEAD ghi
            """
            )
        )

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        XCTAssertEqual(
            verdict,
            .go(worktrees: ["/checkouts/cp-worktrees/w1/bp-1", "/checkouts/cp-worktrees/w1/bp-2"]))
    }

    func testADirectoryGitWillNotDescribeIsARefusal() {
        let git = Git()
        git.answers["--git-common-dir"] = (128, "fatal: not a git repository")

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        guard case .refused(let reason) = verdict else {
            return XCTFail("expected a refusal, got \(verdict)")
        }
        XCTAssertTrue(reason.contains("could not tell"), reason)
    }

    func testTheFirstWorktreeListedIsNeverOfferedForDeletion() {
        let git = Git()
        git.present = ["/checkouts/SB", "/checkouts/elsewhere", "/checkouts/cp-worktrees/w1/bp-1"]
        git.answers["worktree"] = (
            0,
            porcelainZ(
            """
            worktree /checkouts/elsewhere
            HEAD abc

            worktree /checkouts/SB
            HEAD def

            worktree /checkouts/cp-worktrees/w1/bp-1
            HEAD ghi
            """
            )
        )

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        XCTAssertEqual(verdict, .go(worktrees: ["/checkouts/cp-worktrees/w1/bp-1"]))
    }

    func testAWorktreeWhoseDirectoryIsGoneIsDroppedRatherThanRefused() {
        let git = Git()
        git.present = ["/checkouts/SB", "/checkouts/cp-worktrees/w1/live"]
        git.answers["worktree"] = (
            0,
            porcelainZ(
            """
            worktree /checkouts/SB
            HEAD abc

            worktree /checkouts/cp-worktrees/w1/live
            HEAD def

            worktree /checkouts/cp-worktrees/w1/pruned
            HEAD ghi
            """
            )
        )

        XCTAssertEqual(
            git.removal().check(path: "/checkouts/SB", workerIsBusy: false),
            .go(worktrees: ["/checkouts/cp-worktrees/w1/live"]))
    }

    func testAWorktreeWhoseStatusCannotBeReadIsARefusal() {
        let git = Git()
        git.present = ["/checkouts/SB", "/checkouts/cp-worktrees/w1/bp-1"]
        git.answers["worktree"] = (
            0,
            porcelainZ(
            """
            worktree /checkouts/SB
            HEAD abc

            worktree /checkouts/cp-worktrees/w1/bp-1
            HEAD def
            """
            )
        )
        git.answers["/checkouts/cp-worktrees/w1/bp-1"] = (128, "")

        guard case .refused(let reason) = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)
        else {
            return XCTFail("an unexaminable worktree is not a clean one")
        }
        XCTAssertTrue(reason.contains("/checkouts/cp-worktrees/w1/bp-1"), reason)
    }

    func testADirectoryThatIsAlreadyGoneIsNotARefusal() {
        let git = Git()
        git.present = []

        XCTAssertEqual(
            git.removal().check(path: "/checkouts/SB", workerIsBusy: false), .go(worktrees: []))
    }

    func testItStopsAtTheFirstRefusal() {
        let git = Git()
        git.answers["--porcelain"] = (0, " M src/a.ts\n")

        _ = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        XCTAssertFalse(git.calls.contains { $0.contains("stash") })
    }
}
