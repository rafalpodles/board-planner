import XCTest
@testable import CPMenubarCore

final class RemoteMatchTests: XCTestCase {
    // The forms git itself accepts interchangeably. Treating these as different repositories is
    // how a machine gets offered a second clone of something it already has.
    func testItTreatsTheFormsOfOneAddressAsOne() {
        let forms = [
            "git@github.com:rafalpodles/board-planner.git",
            "https://github.com/rafalpodles/board-planner",
            "https://github.com/rafalpodles/board-planner.git",
            "ssh://git@github.com/rafalpodles/board-planner.git",
            "https://github.com/rafalpodles/board-planner/",
            "https://GitHub.com/rafalpodles/Board-Planner",
        ]

        for form in forms {
            XCTAssertTrue(
                RemoteMatch.same(form, "git@github.com:rafalpodles/board-planner.git"),
                "\(form) did not match")
        }
    }

    // The other direction is worse: pairing a project with somebody else's checkout
    func testItKeepsDifferentRepositoriesApart() {
        XCTAssertFalse(RemoteMatch.same(
            "git@github.com:rafalpodles/board-planner.git",
            "git@github.com:rafalpodles/board-planner-site.git"))
        XCTAssertFalse(RemoteMatch.same(
            "git@github.com:rafalpodles/ventures.git",
            "git@gitlab.com:rafalpodles/ventures.git"))
        XCTAssertFalse(RemoteMatch.same(
            "git@github.com:someone/repo.git",
            "git@github.com:someoneelse/repo.git"))
    }

    // A local path is a remote too — it is what a rig clones from
    func testItMatchesALocalPath() {
        XCTAssertTrue(RemoteMatch.same("/Users/rpo/origins/sandbox.git", "/Users/rpo/origins/sandbox"))
    }

    // Nothing matches nothing. An empty remote is a checkout git could not answer for, and pairing
    // it with a project that also has no address would connect two absences.
    func testEmptyMatchesNothing() {
        XCTAssertFalse(RemoteMatch.same("", ""))
        XCTAssertFalse(RemoteMatch.same("", "git@github.com:o/r.git"))
    }

    func testItKeepsAPortOutOfThePath() {
        XCTAssertTrue(RemoteMatch.same(
            "ssh://git@git.example.com:2222/owner/repo.git",
            "ssh://git@git.example.com:2222/owner/repo"))
        XCTAssertFalse(RemoteMatch.same(
            "ssh://git@git.example.com:2222/owner/repo.git",
            "ssh://git@git.example.com/owner/repo.git"))
    }
}
