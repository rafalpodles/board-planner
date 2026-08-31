import XCTest
@testable import CPMenubarCore

private struct Boom: Error, LocalizedError {
    let path: String
    var errorDescription: String? { "could not remove \(path)" }
}

final class CheckoutDeletionTests: XCTestCase {
    /// Captures what was asked of the disk, in order, so the sequence can be asserted rather than
    /// described. The order is the whole point: the grant is what lets the worker touch the
    /// directory, so dropping it before the delete succeeds strands a directory nothing may clean.
    private final class Recorder: @unchecked Sendable {
        var removed: [String] = []
        var forgotten: [String] = []
        var failOn: String?

        func remove(_ path: String) throws {
            if path == failOn { throw Boom(path: path) }
            removed.append(path)
        }

        func forget(_ path: String) throws { forgotten.append(path) }
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

    func testARefusalNeverReachesTheDisk() {
        let r = Recorder()

        let step = deletion(r).removeIfSafe(
            project: "BP", path: "/co", workerIsBusy: false, checking: alwaysRefusing())

        guard case .refused = step else { return XCTFail("expected the guard's refusal, got \(step)") }
        XCTAssertEqual(r.removed, [], "nothing is deleted when the guard says no")
        XCTAssertEqual(r.forgotten, [], "and the grant stays, so the worker may still clean up")
    }

    /// What the guard found is what gets deleted. The two used to be wired together by hand in the
    /// app target, where passing an empty list would have deleted no worktrees and told nobody.
    func testItDeletesExactlyTheWorktreesTheGuardFound() {
        let r = Recorder()

        let step = deletion(r).removeIfSafe(
            project: "BP", path: "/co", workerIsBusy: false,
            checking: allowing(["/wt/one", "/wt/two"]))

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/wt/two", "/co"])
    }
}
