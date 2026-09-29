import XCTest
@testable import CPMenubarCore

// BP-733. git and gh by the path preflight resolved, and nothing at all without one.
final class ToolCommandTests: XCTestCase {
    private let resolved = ["git": "/opt/homebrew/bin/git", "gh": "/opt/homebrew/bin/gh"]

    func testSpawnsTheResolvedPathWithTheArgumentsUnchanged() {
        XCTAssertEqual(
            try ToolCommand.make(.gh, ["auth", "token", "--user", "octocat"], resolved: resolved).get(),
            ToolCommand(executable: "/opt/homebrew/bin/gh", arguments: ["auth", "token", "--user", "octocat"]))
        XCTAssertEqual(
            try ToolCommand.make(.git, ["status"], resolved: resolved).get().executable, "/opt/homebrew/bin/git")
    }

    func testRefusesAToolPreflightResolvedNoPathFor() {
        XCTAssertEqual(
            ToolCommand.make(.gh, ["auth", "token"], resolved: ["git": "/usr/bin/git"]),
            .failure(UnresolvedTool(tool: .gh)))
    }

    func testRefusesTheBareNameRatherThanHandingItToThePath() {
        XCTAssertEqual(
            ToolCommand.make(.git, ["status"], resolved: ["git": "git"]),
            .failure(UnresolvedTool(tool: .git)))
    }

    func testTheRefusalNamesTheToolAndTheWayOut() {
        let reason = UnresolvedTool(tool: .gh).localizedDescription

        XCTAssertTrue(reason.contains("No absolute gh path was resolved"), reason)
        XCTAssertTrue(reason.contains("run the setup check again"), reason)
    }
}
