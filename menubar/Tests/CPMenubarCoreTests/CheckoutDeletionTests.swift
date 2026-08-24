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

        guard case .failed(let project, let reason) = step else {
            XCTFail("expected a failure, got \(step)")
            return
        }
        XCTAssertEqual(project, "BP")
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

    /// The control: a checkout already gone is not an error, and the grant still has to go.
    func testACheckoutThatIsAlreadyGoneStillDropsItsGrant() {
        let r = Recorder()

        let step = deletion(r, exists: { _ in false }).perform(
            project: "BP", path: "/co", worktrees: [])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, [], "nothing to delete")
        XCTAssertEqual(r.forgotten, ["/co"], "but the allowlist entry is still stale")
    }
}
