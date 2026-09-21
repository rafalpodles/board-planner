import XCTest
@testable import CPMenubarCore

/// The discriminator on its own. `CheckoutRemovalWorktreeTests` proves it against real git for the
/// two shapes that matter; these are the answers git gives that no fixture in this repository
/// happens to produce, and that nothing else would notice going wrong.
final class LinkedWorktreeCheckTests: XCTestCase {
    private func kind(_ gitDir: (Int32, String), _ commonDir: (Int32, String), at path: String)
        -> GitCheckoutKind?
    {
        LinkedWorktreeCheck.kind(gitDir: gitDir, commonDir: commonDir, relativeTo: path)
    }

    func testAnOrdinaryCheckoutAnswersBothTheSameWay() {
        XCTAssertEqual(kind((0, ".git"), (0, ".git"), at: "/repo"), .repository)
    }

    func testAWorktreeAnswersWithTheRepositoryAndItsOwnGitDir() {
        XCTAssertEqual(
            kind((0, "/repo/.git/worktrees/w"), (0, "/repo/.git"), at: "/repo/../w"),
            .linkedWorktree)
    }

    /// The reason the answers are made absolute against `path` before they are compared, rather
    /// than compared as they arrive. Measured on git 2.50.1: from a subdirectory of an ordinary
    /// checkout, `--git-dir` answers absolute and `--git-common-dir` answers relative. Comparing
    /// the strings would call that a linked worktree and refuse a healthy repository.
    ///
    /// `CheckoutRemoval` never sees it — its `--show-toplevel` guard runs first — but `CloneStep`
    /// has no such guard, and nothing else in the suite feeds this pair a mixed answer.
    func testAMixedRelativeAndAbsolutePairIsStillOneRepository() {
        XCTAssertEqual(
            kind((0, "/repo/.git"), (0, "../../.git"), at: "/repo/deep/er"),
            .repository)
    }

    func testAnAnswerGitCouldNotGiveIsNotAnAnswer() {
        XCTAssertNil(kind((128, "fatal: not a git repository"), (0, ".git"), at: "/repo"))
        XCTAssertNil(kind((0, ".git"), (128, ""), at: "/repo"))
        XCTAssertNil(kind((0, ""), (0, ".git"), at: "/repo"))
    }

    /// `git rev-parse` echoes an option it does not recognise and exits 0, so on a git predating
    /// `--git-common-dir` the answer is the flag. The exit code alone would take it for a path.
    func testAnEchoedOptionIsNotAPath() {
        XCTAssertNil(kind((0, ".git"), (0, "--git-common-dir"), at: "/repo"))
    }

    // MARK: - BP-507: a submodule's working directory answers like a repository

    /// The shape `CheckoutRemovalWorktreeTests`' submodule fixture measures against real git:
    /// `--git-dir` and `--git-common-dir` agree, same as an ordinary repository, but the agreed
    /// path is a `modules/<name>` child of the superproject's `.git`.
    func testASubmoduleWorkingDirectoryIsNeitherARepositoryNorAWorktree() {
        XCTAssertEqual(
            kind((0, "/super/.git/modules/vendor"), (0, "/super/.git/modules/vendor"), at: "/super/vendor"),
            .submodule)
    }

    /// A nested submodule (a submodule inside a submodule) nests the same `modules/` segment
    /// rather than repeating `.git/` — containment has to look for the segment anywhere in the
    /// path, not just as a suffix of the superproject's own `.git`.
    func testANestedSubmoduleIsStillDetected() {
        XCTAssertEqual(
            kind(
                (0, "/super/.git/modules/outer/modules/inner"),
                (0, "/super/.git/modules/outer/modules/inner"),
                at: "/super/outer/inner"),
            .submodule)
    }

    /// The control: an ordinary repository's git-dir has no `modules/` segment at all, so the
    /// existing case still answers `.repository` rather than being swallowed by the new one.
    func testAnOrdinaryRepositoryIsStillARepository() {
        XCTAssertEqual(
            kind((0, "/repo/.git"), (0, "/repo/.git"), at: "/repo"),
            .repository)
    }
}
