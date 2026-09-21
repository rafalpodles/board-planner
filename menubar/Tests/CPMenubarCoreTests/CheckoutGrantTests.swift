import XCTest
@testable import CPMenubarCore

/// The picker's half of BP-505. `LinkedWorktreeCheckTests` proves the discriminator itself; these
/// are the two answers `CheckoutGrant` gives from it; the fixtures mirror `LinkedWorktreeCheckTests`
/// rather than spawning real git, since the discriminator's own git behaviour is proved there.
final class CheckoutGrantTests: XCTestCase {
    private func check(gitDir: (Int32, String), commonDir: (Int32, String), at path: String) -> CheckoutGrant {
        CheckoutGrant.check(path: path) { args, _ in
            if args.contains("--git-dir") { return gitDir }
            if args.contains("--git-common-dir") { return commonDir }
            XCTFail("unexpected git call: \(args)")
            return (1, "")
        }
    }

    /// The control: a folder the picker already accepts today keeps being accepted.
    func testAnOrdinaryCheckoutIsAllowed() {
        XCTAssertEqual(check(gitDir: (0, ".git"), commonDir: (0, ".git"), at: "/repo"), .allowed)
    }

    /// The bug: a linked worktree used to be written to `repos.json` with no check at all.
    func testALinkedWorktreeIsRefused() {
        let verdict = check(
            gitDir: (0, "/repo/.git/worktrees/w"), commonDir: (0, "/repo/.git"), at: "/repo/../w")

        guard case .refused(let reason) = verdict else {
            return XCTFail("expected a refusal, got \(verdict)")
        }
        XCTAssertTrue(reason.contains("is a linked worktree"), reason)
    }

    /// A directory git cannot examine is not the shape this check exists for — the picker accepted
    /// every such folder before BP-505 too, and widening the refusal here is a different ticket.
    func testADirectoryGitCannotExamineIsStillAllowed() {
        XCTAssertEqual(
            check(gitDir: (128, "fatal: not a git repository"), commonDir: (0, ".git"), at: "/repo"),
            .allowed)
    }

    /// BP-507 review. This file used to compare `== .linkedWorktree` rather than switch, so adding
    /// `.submodule` to the discriminator left a granted submodule silently `.allowed` — the same
    /// problem BP-505 introduced this whole check to close for a linked worktree, since
    /// `CheckoutRemoval` refuses to delete either one standalone once it is.
    func testASubmoduleWorkingDirectoryIsRefused() {
        let verdict = check(
            gitDir: (0, "/super/.git/modules/vendor"), commonDir: (0, "/super/.git/modules/vendor"),
            at: "/super/vendor")

        guard case .refused(let reason) = verdict else {
            return XCTFail("expected a refusal, got \(verdict)")
        }
        XCTAssertTrue(reason.contains("submodule"), reason)
    }
}
