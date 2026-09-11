import XCTest
@testable import CPMenubarCore

private struct Boom: Error, LocalizedError {
    let path: String
    var errorDescription: String? { "could not remove \(path)" }
}

// @MainActor for `removeIfSafe`, which is isolated to it because asking the operator is a modal.
// `perform` is not, and the tests above it would compile either way.
@MainActor
final class CheckoutDeletionTests: XCTestCase {
    /// Captures what was asked of the disk, in order, so the sequence can be asserted rather than
    /// described. The order is the whole point: the grant is what lets the worker touch the
    /// directory, so dropping it before the delete succeeds strands a directory nothing may clean.
    private final class Recorder: @unchecked Sendable {
        var removed: [String] = []
        var forgotten: [String] = []
        var failOn: String?
        var failForget = false

        func remove(_ path: String) throws {
            if path == failOn { throw Boom(path: path) }
            removed.append(path)
        }

        func forget(_ path: String) throws {
            if failForget { throw Boom(path: path) }
            forgotten.append(path)
        }
    }

    private func deletion(_ r: Recorder, exists: @escaping @Sendable (String) -> Bool = { _ in true })
        -> CheckoutDeletion
    {
        CheckoutDeletion(remove: { try r.remove($0) }, exists: exists, forget: { try r.forget($0) })
    }

    func testItTakesTheWorktreesFirst_thenTheCheckout_thenTheGrant() {
        let r = Recorder()

        let step = deletion(r).perform(
            project: "BP", path: "/co", worktrees: ["/wt/one", "/wt/two"])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/wt/two", "/co"], "worktrees before the checkout")
        XCTAssertEqual(r.forgotten, ["/co"], "the grant goes last, and only on success")
    }

    /// The bug this file exists for. `try?` used to swallow this, leaving no step and letting the
    /// run report `.removed` for a checkout whose worktrees were still there.
    func testAWorktreeThatWillNotDeleteFailsTheWholeRemoval() {
        let r = Recorder()
        r.failOn = "/wt/two"

        let step = deletion(r).perform(
            project: "BP", path: "/co", worktrees: ["/wt/one", "/wt/two", "/wt/three"])

        // Partial, not failed: /wt/one is gone and saying only "/wt/two could not be removed"
        // reads as nothing having happened (BP-427).
        guard case .partiallyRemoved(let project, let removed, let reason) = step else {
            XCTFail("expected a partial removal, got \(step)")
            return
        }
        XCTAssertEqual(project, "BP")
        XCTAssertEqual(removed, ["/wt/one"], "what already went is named")
        XCTAssertTrue(reason.contains("/wt/two"), "the reason names the worktree: \(reason)")
        XCTAssertEqual(r.removed, ["/wt/one"], "it stops at the throw rather than carrying on")
        XCTAssertFalse(r.removed.contains("/co"), "the checkout survives a failed worktree delete")
        XCTAssertEqual(r.forgotten, [], "and the grant is not dropped, so the worker may still clean up")
    }

    func testAFailedCheckoutDeleteKeepsTheGrant() {
        let r = Recorder()
        r.failOn = "/co"

        let step = deletion(r).perform(project: "BP", path: "/co", worktrees: [])

        guard case .failed = step else {
            XCTFail("expected a failure, got \(step)")
            return
        }
        XCTAssertEqual(r.forgotten, [], "a directory nothing may touch, with nothing on screen, is the worse end")
    }

    /// A checkout already gone is not an error, and the grant still has to go — but it is not a
    /// removal either. The first version of this test asserted `.removed`, which would have told
    /// an operator a directory was deleted when it was still on disk under another name or on an
    /// unmounted volume. They would find out by going to look for it.
    func testACheckoutThatIsAlreadyGoneIsForgotten_notReported_asRemoved() {
        let r = Recorder()

        let step = deletion(r, exists: { _ in false }).perform(
            project: "BP", path: "/co", worktrees: [])

        XCTAssertEqual(step, .forgotten(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, [], "nothing to delete")
        XCTAssertEqual(r.forgotten, ["/co"], "but the allowlist entry is still stale")
    }

    /// The other side of the same distinction, so neither outcome can drift into the other.
    func testACheckoutThatWasThereIsReportedAsRemoved() {
        let r = Recorder()

        let step = deletion(r, exists: { _ in true }).perform(
            project: "BP", path: "/co", worktrees: [])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/co"])
    }

    // MARK: - removeIfSafe: the seam that used to live in an untested app target

    private func alwaysRefusing() -> CheckoutRemoval {
        CheckoutRemoval(run: { _, _ in (128, "nope") }, exists: { _ in true })
    }

    private func allowing(_ worktrees: [String]) -> CheckoutRemoval {
        CheckoutRemoval(
            run: { args, _ in
                if args.contains("--show-toplevel") { return (0, "/co\n") }
                if args.contains("--git-dir") || args.contains("--git-common-dir") { return (0, ".git") }
                if args.contains("worktree") {
                    return (0, porcelainZ((["/co"] + worktrees).map { "worktree \($0)" }.joined(separator: "\n\n")))
                }
                return (0, "")
            },
            exists: { _ in true })
    }

    /// Records what the operator was asked, so "it named every path" can be asserted rather than
    /// described, and answers whatever the test told it to.
    private final class Asked: @unchecked Sendable {
        var calls: [(project: String, paths: [String])] = []
        var answer = true

        func ask(_ project: String, _ paths: [String]) -> Bool {
            calls.append((project, paths))
            return answer
        }
    }

    private func idle() -> CheckoutDeletion.IsBusy { { false } }

    func testARefusalNeverReachesTheDisk() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(), checking: alwaysRefusing(),
            asking: { asked.ask($0, $1) })

        guard case .refused = step else { return XCTFail("expected the guard's refusal, got \(step)") }
        XCTAssertEqual(r.removed, [], "nothing is deleted when the guard says no")
        XCTAssertEqual(r.forgotten, [], "and the grant stays, so the worker may still clean up")
        XCTAssertEqual(asked.calls.count, 0, "nobody is asked about a deletion that is not going to happen")
    }

    /// What the guard found is what gets deleted. The two used to be wired together by hand in the
    /// app target, where passing an empty list would have deleted no worktrees and told nobody.
    func testItDeletesExactlyTheWorktreesTheGuardFound() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: allowing(["/wt/one", "/wt/two"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/wt/two", "/co"])
    }

    // MARK: - BP-378: unticking is a proposal, and the machine is where it is put

    /// The criterion, directly: every resolved path is named — the checkout and each linked
    /// worktree — and they are the paths the guard resolved, not ones the server guessed.
    func testTheOperatorIsAskedWithTheCheckoutAndEveryWorktree() async {
        let r = Recorder()
        let asked = Asked()

        _ = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: allowing(["/wt/one", "/wt/two"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(asked.calls.count, 1, "asked once, immediately before the delete")
        XCTAssertEqual(asked.calls.first?.project, "BP")
        XCTAssertEqual(
            asked.calls.first?.paths, ["/co", "/wt/one", "/wt/two"],
            "the checkout first, then what goes with it — nothing deleted goes unnamed")
    }

    func testDecliningDeletesNothingAndKeepsTheGrant() async {
        let r = Recorder()
        let asked = Asked()
        asked.answer = false

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: allowing(["/wt/one"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .declined(project: "BP", paths: ["/co", "/wt/one"]))
        XCTAssertEqual(r.removed, [], "no is a no about the disk")
        XCTAssertEqual(
            r.forgotten, [],
            "and about the allowlist: dropping the grant would leave a checkout the worker may no longer touch")
    }

    /// A checkout that went on its own. The grant is stale and dropping it destroys nothing, so
    /// putting a deletion dialog in front of somebody would be asking about nothing.
    func testNothingToDeleteIsNotWorthAsking() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r, exists: { _ in false }).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(), checking: allowing([]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .forgotten(project: "BP", path: "/co"))
        XCTAssertEqual(asked.calls.count, 0, "nothing was going to be deleted")
        XCTAssertEqual(r.forgotten, ["/co"], "the stale entry still goes")
    }

    /// BP-424 with a longer window. That ticket was about a worker picking up a task during a
    /// clone; a modal waits on a person, which is longer still. A `removeIfSafe` that asked once
    /// before the dialog would pass every test above and delete a live worktree here.
    func testAWorkerThatPicksUpATaskWhileTheQuestionIsOnScreenStopsTheDelete() async {
        let r = Recorder()
        let asked = Asked()
        let busy = Counter()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: { busy.next() },
            checking: allowing(["/wt/one"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(asked.calls.count, 1, "it did ask — the worker was idle when the guards ran")
        guard case .refused(_, let reason) = step else {
            return XCTFail("expected a refusal on the second look, got \(step)")
        }
        XCTAssertTrue(reason.contains("running a task"), "and says why: \(reason)")
        XCTAssertEqual(r.removed, [], "nothing is taken from under a run")
        XCTAssertEqual(r.forgotten, [])
    }

    /// The operator agreed to a list. A worktree created while the dialog sat on screen is not on
    /// it, and deleting it would be destroying something they were never shown.
    func testAWorktreeThatAppearsWhileTheQuestionIsOnScreenStopsTheDelete() async {
        let r = Recorder()
        let asked = Asked()
        let worktrees = Growing(first: ["/wt/one"], then: ["/wt/one", "/wt/late"])

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: CheckoutRemoval(
                run: { args, _ in stubGit(args, worktrees: worktrees) },
                exists: { _ in true }),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(asked.calls.first?.paths, ["/co", "/wt/one"], "asked about what was there then")
        guard case .refused(_, let reason) = step else {
            return XCTFail("expected a refusal, got \(step)")
        }
        // The line lands in the Repositories pane as something to act on, so it has to name what
        // changed. "Something changed" is not something anybody can act on.
        XCTAssertTrue(reason.contains("/wt/late appeared"), reason)
        XCTAssertTrue(reason.contains("while the question was on screen"), reason)
        XCTAssertTrue(reason.contains("it will ask again"), reason)
        XCTAssertEqual(r.removed, [], "and /wt/late, which nobody was shown, is still there")
    }

    /// The control for the two above: when nothing changes between the two looks, agreeing still
    /// deletes. Without it, a `removeIfSafe` that refused everything after a confirmation would
    /// pass both.
    func testAgreeingWithNothingChangingStillDeletes() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: allowing(["/wt/one"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/co"])
        XCTAssertEqual(r.forgotten, ["/co"])
    }

    // MARK: - BP-427: what the operator is told when only some of it went

    /// The checkout itself refuses after both worktrees are already gone. The old step named the
    /// checkout and nothing else, which reads as "nothing was deleted" — the opposite of the truth.
    func testAFailedCheckoutDeleteStillNamesTheWorktreesThatWent() {
        let r = Recorder()
        r.failOn = "/co"

        let step = deletion(r).perform(
            project: "BP", path: "/co", worktrees: ["/wt/one", "/wt/two"])

        XCTAssertEqual(
            step,
            .partiallyRemoved(
                project: "BP", removed: ["/wt/one", "/wt/two"], reason: "could not remove /co"))
        XCTAssertEqual(r.forgotten, [], "the grant stays, so the worker may still clean up")
    }

    /// Everything is deleted and only the allowlist write fails. The disk is in its final state and
    /// the grant is not — the one case where "partly done" means the directory is gone.
    func testAFailedForgetAfterEverythingWentIsStillPartial() {
        let r = Recorder()
        r.failForget = true

        let step = deletion(r).perform(project: "BP", path: "/co", worktrees: ["/wt/one"])

        guard case .partiallyRemoved(_, let removed, _) = step else {
            return XCTFail("expected a partial removal, got \(step)")
        }
        XCTAssertEqual(removed, ["/wt/one", "/co"], "the checkout is gone and has to be named")
    }

    /// The control that keeps the new case honest: when the very first act throws, nothing went,
    /// and "partly removed" would be its own kind of lie.
    func testAFirstActThatThrowsIsStillAPlainFailure() {
        let r = Recorder()
        r.failOn = "/wt/one"

        let step = deletion(r).perform(project: "BP", path: "/co", worktrees: ["/wt/one", "/wt/two"])

        XCTAssertEqual(step, .failed(project: "BP", reason: "could not remove /wt/one"))
        XCTAssertEqual(r.removed, [], "and nothing reached the disk")
    }

    /// The other control: a removal that finishes is reported exactly as it was before.
    func testACompleteRemovalIsUnchanged() {
        let r = Recorder()

        let step = deletion(r).perform(project: "BP", path: "/co", worktrees: ["/wt/one"])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/co"])
        XCTAssertEqual(r.forgotten, ["/co"])
    }
}

/// Idle on the first question, running on every one after it — the worker picking up a task while
/// the confirmation is on screen.
private final class Counter: @unchecked Sendable {
    private var asked = 0
    func next() -> Bool {
        defer { asked += 1 }
        return asked > 0
    }
}

/// One set of worktrees for the first `check`, another for the second.
private final class Growing: @unchecked Sendable {
    private let first: [String]
    private let then: [String]
    private var looks = 0

    init(first: [String], then: [String]) {
        self.first = first
        self.then = then
    }

    func next() -> [String] {
        defer { looks += 1 }
        return looks == 0 ? first : then
    }
}

/// A git that answers every question `CheckoutRemoval` asks with yes, naming whichever set of
/// worktrees this look is meant to see. The set advances on the `worktree list` call alone — a
/// check runs half a dozen git commands, and advancing on each one made the first look already see
/// the second set.
@Sendable private func stubGit(_ args: [String], worktrees: Growing) -> (code: Int32, output: String) {
    if args.contains("--show-toplevel") { return (0, "/co\n") }
    if args.contains("--git-dir") || args.contains("--git-common-dir") { return (0, ".git") }
    if args.contains("worktree") {
        let listed = worktrees.next()
        return (0, porcelainZ((["/co"] + listed).map { "worktree \($0)" }.joined(separator: "\n\n")))
    }
    return (0, "")
}
