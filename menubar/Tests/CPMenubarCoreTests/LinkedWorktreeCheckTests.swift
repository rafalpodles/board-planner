import XCTest
@testable import CPMenubarCore

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

    func testAnEchoedOptionIsNotAPath() {
        XCTAssertNil(kind((0, ".git"), (0, "--git-common-dir"), at: "/repo"))
    }
}
