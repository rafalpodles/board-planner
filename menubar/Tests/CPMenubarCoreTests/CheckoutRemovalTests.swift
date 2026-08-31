import XCTest
@testable import CPMenubarCore

/// A porcelain listing in the shape `-z` actually emits — every attribute NUL-terminated, records
/// separated by an empty field. Written from the readable form so the fixtures below stay legible
/// while the parser still sees its real input. Measured against git rather than assumed: `-z`
/// swaps the "\n" terminator for "\0" and changes nothing else.
func porcelainZ(_ readable: String) -> String {
    readable
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .joined(separator: "\0") + "\0"
}

final class CheckoutRemovalTests: XCTestCase {
    private final class Git: @unchecked Sendable {
        /// Keyed on the git subcommand, so a test says what one answer is and inherits the rest
        var answers: [String: (Int32, String)] = [:]
        var present: Set<String> = ["/checkouts/SB"]
        var calls: [[String]] = []

        func removal() -> CheckoutRemoval {
            CheckoutRemoval(
                run: { args, _ in
                    self.calls.append(args)
                    for (needle, answer) in self.answers where args.contains(needle) { return answer }
                    // A clean checkout with no worktrees, unless a test says otherwise
                    if args.contains("--show-toplevel") { return (0, "/checkouts/SB\n") }
                    // A repository rather than one of its worktrees: the two answers agree
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

    // First, and regardless of what the directory looks like: a run whose worktree vanishes fails
    // in ways that read as anything except "somebody deleted it".
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

    // The case an ahead/behind check misses: a branch that never had an upstream still holds work
    // that exists nowhere else.
    func testItRefusesCommitsThatAreOnNoRemote() {
        let git = Git()
        git.answers["--not"] = (0, "abc1234 wip\ndef5678 more wip\n")

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        guard case .refused(let reason) = verdict else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("2 commits"), reason)
        XCTAssertTrue(reason.contains("no remote"), reason)
    }

    // `git status` does not show a stash, and a stash dies with the directory
    func testItRefusesACheckoutWithAStash() {
        let git = Git()
        git.answers["stash"] = (0, "stash@{0}: WIP on main: abc123\n")

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        guard case .refused(let reason) = verdict else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("stashed"), reason)
    }

    // The rule that carries the weight now the "only our own folder" rail is gone: unexamined is
    // not clean. Each of these is a check that could not run, and each has to read as a no.
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

    // A path can be a subdirectory of a checkout, and deleting one of those takes part of a
    // repository rather than the repository.
    func testItRefusesASubdirectoryOfACheckout() {
        let git = Git()
        git.present = ["/checkouts/SB/src"]
        git.answers["--show-toplevel"] = (0, "/checkouts/SB\n")

        let verdict = git.removal().check(path: "/checkouts/SB/src", workerIsBusy: false)

        guard case .refused(let reason) = verdict else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("inside the checkout"), reason)
    }

    // Deleting the shared cp-worktrees root wholesale would take another project's worktrees with
    // it, so the ones belonging to THIS checkout are named instead.
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


    /// Unexamined is not clean — the rule this whole file is built on, applied to the one question
    /// that decides whether the path is a repository at all. Without it the answer git could not
    /// give would be read as "an ordinary checkout" and the repository would be deleted.
    func testADirectoryGitWillNotDescribeIsARefusal() {
        let git = Git()
        git.answers["--git-common-dir"] = (128, "fatal: not a git repository")

        let verdict = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        guard case .refused(let reason) = verdict else {
            return XCTFail("expected a refusal, got \(verdict)")
        }
        XCTAssertTrue(reason.contains("could not tell"), reason)
    }

    /// BP-422's second line, and the only place it can be exercised: `check` now refuses a linked
    /// worktree before the list is built, so nothing reaching real git can produce this shape. What
    /// the invariant says is that the FIRST entry is never returned — `git worktree list` names the
    /// repository's main checkout there, whichever worktree it was run from, and filtering on
    /// `root` alone left it in the list exactly when `root` was not it.
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

    /// A worktree somebody removed with `rm -rf` and never pruned. It is still registered, and
    /// there is nothing on disk to lose — so it must not appear in the list the caller deletes,
    /// or the removal fails on it every poll for ever (BP-418).
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

    /// The file's own rule, applied to the arm this branch added: a check that cannot be run is a
    /// no. `--porcelain` reaches the checkout's own status first, so the worktree's needs its own
    /// case or it can be deleted without anyone noticing.
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
        // Only the worktree's status fails; the checkout's has already passed by then. The output
        // is empty on purpose: with a message here, dropping the exit-code guard would still refuse
        // — reading the error text as a list of changed files — and this test would pass against a
        // guard that was not there.
        git.answers["/checkouts/cp-worktrees/w1/bp-1"] = (128, "")

        guard case .refused(let reason) = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)
        else {
            return XCTFail("an unexaminable worktree is not a clean one")
        }
        XCTAssertTrue(reason.contains("/checkouts/cp-worktrees/w1/bp-1"), reason)
    }

    // The allowlist entry still has to go; there is simply nothing on disk to delete.
    func testADirectoryThatIsAlreadyGoneIsNotARefusal() {
        let git = Git()
        git.present = []

        XCTAssertEqual(
            git.removal().check(path: "/checkouts/SB", workerIsBusy: false), .go(worktrees: []))
    }

    // Cheapest first, and nothing runs after a no: a refusal must not leave git commands running
    // against a directory the operator is about to be told is untouchable.
    func testItStopsAtTheFirstRefusal() {
        let git = Git()
        git.answers["--porcelain"] = (0, " M src/a.ts\n")

        _ = git.removal().check(path: "/checkouts/SB", workerIsBusy: false)

        XCTAssertFalse(git.calls.contains { $0.contains("stash") })
    }
}
