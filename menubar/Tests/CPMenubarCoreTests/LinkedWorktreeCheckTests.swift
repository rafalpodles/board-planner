import XCTest
@testable import CPMenubarCore

/// The discriminator on its own. `CheckoutRemovalWorktreeTests` proves it against real git for the
/// two shapes that matter; these are the answers git gives that no fixture in this repository
/// happens to produce, and that nothing else would notice going wrong.
final class LinkedWorktreeCheckTests: XCTestCase {
    private func kind(
        _ gitDir: (Int32, String), _ commonDir: (Int32, String), superproject: (Int32, String) = (0, ""),
        at path: String
    ) -> GitCheckoutKind? {
        LinkedWorktreeCheck.kind(gitDir: gitDir, commonDir: commonDir, superproject: superproject, relativeTo: path)
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

    // MARK: - BP-507, BP-734: a submodule's working directory answers like a repository

    /// `--git-dir` and `--git-common-dir` agree, same as an ordinary repository; what tells them
    /// apart is git naming a superproject.
    func testASubmoduleWorkingDirectoryIsNeitherARepositoryNorAWorktree() {
        XCTAssertEqual(
            kind(
                (0, "/super/.git/modules/vendor"), (0, "/super/.git/modules/vendor"),
                superproject: (0, "/super\n"), at: "/super/vendor"),
            .submodule)
    }

    /// The shapes BP-507's `/.git/modules/` substring missed, with the answers git gave for each
    /// in `SubmoduleLayoutTests`' fixtures: a superproject `.git` that is a symlink or a separate
    /// git dir reports the resolved `<elsewhere>/modules/vendor`, and a legacy submodule reports
    /// its own `.git`.
    func testASubmoduleWithNoModulesSegmentInItsGitDirIsStillASubmodule() {
        XCTAssertEqual(
            kind(
                (0, "/super/realgit/modules/vendor"), (0, "/super/realgit/modules/vendor"),
                superproject: (0, "/super\n"), at: "/super/vendor"),
            .submodule)
        XCTAssertEqual(
            kind((0, ".git"), (0, ".git"), superproject: (0, "/super\n"), at: "/super/vendor"),
            .submodule)
    }

    /// An empty superproject answer is also what git gives when it could not read the parent's
    /// index, or found no gitlink there for a submodule left behind by a checkout (BP-734 review).
    /// A git-dir under `/.git/modules/` is then still a submodule's — and so is it when the
    /// superproject question failed outright, rather than unexamined.
    func testAModulesSegmentIsASubmoduleWhateverTheSuperprojectAnswer() {
        XCTAssertEqual(
            kind((0, "/super/.git/modules/vendor"), (0, "/super/.git/modules/vendor"), at: "/super/vendor"),
            .submodule)
        XCTAssertEqual(
            kind(
                (0, "/super/.git/modules/vendor"), (0, "/super/.git/modules/vendor"),
                superproject: (128, "fatal"), at: "/super/vendor"),
            .submodule)
        XCTAssertEqual(
            kind(
                (0, "/super/.git/modules/vendor"), (0, "/super/.git/modules/vendor"),
                superproject: (0, "--show-superproject-working-tree\n"), at: "/super/vendor"),
            .submodule)
    }

    /// The control: an ordinary repository answers the superproject question with nothing.
    func testAnOrdinaryRepositoryIsStillARepository() {
        XCTAssertEqual(
            kind((0, "/repo/.git"), (0, "/repo/.git"), superproject: (0, "\n"), at: "/repo"),
            .repository)
    }

    /// Unexamined is not "no superproject": a failed spawn, or a git older than 2.13 echoing the
    /// flag it does not know, is not an answer.
    func testASuperprojectAnswerGitCouldNotGiveIsNotAnAnswer() {
        XCTAssertNil(kind((0, ".git"), (0, ".git"), superproject: (128, ""), at: "/repo"))
        XCTAssertNil(
            kind((0, ".git"), (0, ".git"), superproject: (0, "--show-superproject-working-tree\n"), at: "/repo"))
    }

    /// A linked worktree is decided before the superproject is looked at.
    func testALinkedWorktreeIsAWorktreeWhateverTheSuperprojectAnswer() {
        XCTAssertEqual(
            kind((0, "/repo/.git/worktrees/w"), (0, "/repo/.git"), superproject: (0, "/super\n"), at: "/w"),
            .linkedWorktree)
    }

    /// `kind(of:run:)` asks all three questions of the path it was given, as `rev-parse` options.
    func testItAsksAllThreeQuestionsOfThePath() {
        var asked: [[String]] = []
        _ = LinkedWorktreeCheck.kind(of: "/repo") { args in
            asked.append(args)
            return (0, ".git")
        }
        XCTAssertEqual(asked, [
            ["-C", "/repo", "rev-parse", "--git-dir"],
            ["-C", "/repo", "rev-parse", "--git-common-dir"],
            ["-C", "/repo", "rev-parse", "--show-superproject-working-tree"],
        ])
    }
}
