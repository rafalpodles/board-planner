import XCTest
@testable import CPMenubarCore

private struct Boom: Error, LocalizedError {
    let path: String
    var errorDescription: String? { "could not remove \(path)" }
}

final class CheckoutDeletionTests: XCTestCase {
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

    func testAWorktreeThatWillNotDeleteFailsTheWholeRemoval() {
        let r = Recorder()
        r.failOn = "/wt/two"

        let step = deletion(r).perform(
            project: "BP", path: "/co", worktrees: ["/wt/one", "/wt/two", "/wt/three"])

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

    func testACheckoutThatIsAlreadyGoneIsForgotten_notReported_asRemoved() {
        let r = Recorder()

        let step = deletion(r, exists: { _ in false }).perform(
            project: "BP", path: "/co", worktrees: [])

        XCTAssertEqual(step, .forgotten(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, [], "nothing to delete")
        XCTAssertEqual(r.forgotten, ["/co"], "but the allowlist entry is still stale")
    }

    func testACheckoutThatWasThereIsReportedAsRemoved() {
        let r = Recorder()

        let step = deletion(r, exists: { _ in true }).perform(
            project: "BP", path: "/co", worktrees: [])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/co"])
    }

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

    func testItDeletesExactlyTheWorktreesTheGuardFound() {
        let r = Recorder()

        let step = deletion(r).removeIfSafe(
            project: "BP", path: "/co", workerIsBusy: false,
            checking: allowing(["/wt/one", "/wt/two"]))

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/wt/two", "/co"])
    }

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

    func testAFailedForgetAfterEverythingWentIsStillPartial() {
        let r = Recorder()
        r.failForget = true

        let step = deletion(r).perform(project: "BP", path: "/co", worktrees: ["/wt/one"])

        guard case .partiallyRemoved(_, let removed, _) = step else {
            return XCTFail("expected a partial removal, got \(step)")
        }
        XCTAssertEqual(removed, ["/wt/one", "/co"], "the checkout is gone and has to be named")
    }

    func testAFirstActThatThrowsIsStillAPlainFailure() {
        let r = Recorder()
        r.failOn = "/wt/one"

        let step = deletion(r).perform(project: "BP", path: "/co", worktrees: ["/wt/one", "/wt/two"])

        XCTAssertEqual(step, .failed(project: "BP", reason: "could not remove /wt/one"))
        XCTAssertEqual(r.removed, [], "and nothing reached the disk")
    }

    func testACompleteRemovalIsUnchanged() {
        let r = Recorder()

        let step = deletion(r).perform(project: "BP", path: "/co", worktrees: ["/wt/one"])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/co"])
        XCTAssertEqual(r.forgotten, ["/co"])
    }
}
