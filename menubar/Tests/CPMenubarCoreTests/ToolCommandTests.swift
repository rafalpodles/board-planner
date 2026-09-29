import XCTest
@testable import CPMenubarCore

// BP-733. git and gh by the path preflight resolved, and nothing at all without one.
final class ToolCommandTests: XCTestCase {
    private let resolved = ["git": "/opt/homebrew/bin/git", "gh": "/opt/homebrew/bin/gh"]

    func testSpawnsTheResolvedPathWithTheArgumentsUnchanged() {
        XCTAssertEqual(
            try ToolCommand.make(.gh, ["auth", "token", "--user", "octocat"], resolved: resolved, isExecutable: { _ in true }).get(),
            ToolCommand(executable: "/opt/homebrew/bin/gh", arguments: ["auth", "token", "--user", "octocat"]))
        XCTAssertEqual(
            try ToolCommand.make(.git, ["status"], resolved: resolved, isExecutable: { _ in true }).get().executable, "/opt/homebrew/bin/git")
    }

    func testRefusesAToolPreflightResolvedNoPathFor() {
        XCTAssertEqual(
            ToolCommand.make(.gh, ["auth", "token"], resolved: ["git": "/usr/bin/git"], isExecutable: { _ in true }),
            .failure(UnresolvedTool(tool: .gh)))
    }

    func testRefusesTheBareNameRatherThanHandingItToThePath() {
        XCTAssertEqual(
            ToolCommand.make(.git, ["status"], resolved: ["git": "git"], isExecutable: { _ in true }),
            .failure(UnresolvedTool(tool: .git)))
    }

    // The recorded path is where preflight found it once; a gh uninstalled since is not there
    func testRefusesARecordedPathThatIsNoLongerThere() {
        XCTAssertEqual(
            ToolCommand.make(.gh, ["auth"], resolved: resolved, isExecutable: { _ in false }),
            .failure(UnresolvedTool(tool: .gh)))
    }

    // A running machine has no setup screen, so the way out named is the one that re-resolves
    func testTheRefusalNamesTheToolAndAWayOutAtEveryStep() {
        let reason = UnresolvedTool(tool: .gh).localizedDescription

        XCTAssertTrue(reason.contains("No gh was found"), reason)
        XCTAssertTrue(reason.contains("quit and reopen the app once it is set up"), reason)
        // …and the one a machine still in setup has, whose screen offers the check instead
        XCTAssertTrue(reason.contains("press Check this machine during setup"), reason)
    }
}
