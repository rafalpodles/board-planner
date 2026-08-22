import XCTest
@testable import CPMenubarCore

final class ProjectSyncTests: XCTestCase {
    private func row(
        _ key: String, repo: String, wanted: Bool, servedHere: Bool, available: Bool = true
    ) -> ProjectCatalogueRow {
        ProjectCatalogueRow(
            project: "p-\(key)", key: key, name: key, repositoryUrl: repo,
            available: available, workersEnabled: true, servedHere: servedHere, wanted: wanted)
    }

    private let bpRemote = "git@github.com:rafalpodles/board-planner.git"
    private let sbRemote = "https://github.com/rafalpodles/ventures"

    func testItClonesWhatWasPickedAndIsMissing() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: true, servedHere: false)],
            checkouts: [:])

        XCTAssertEqual(plan.add.map(\.key), ["SB"])
        XCTAssertTrue(plan.remove.isEmpty)
    }

    func testItRemovesWhatWasUntickedAndIsPresent() {
        let plan = ProjectSync.plan(
            catalogue: [row("BP", repo: bpRemote, wanted: false, servedHere: true)],
            checkouts: ["/checkouts/BP": bpRemote])

        XCTAssertTrue(plan.add.isEmpty)
        XCTAssertEqual(plan.remove.map(\.path), ["/checkouts/BP"])
    }

    // Steady state has to be silent, or every poll re-does the last one
    func testItDoesNothingWhenTheDiskAlreadyAgrees() {
        let plan = ProjectSync.plan(
            catalogue: [
                row("BP", repo: bpRemote, wanted: true, servedHere: true),
                row("SB", repo: sbRemote, wanted: false, servedHere: false),
            ],
            checkouts: ["/checkouts/BP": bpRemote])

        XCTAssertTrue(plan.isEmpty)
    }

    // The checkout the operator added by hand, somewhere of their own choosing, in whichever form
    // of the address git wrote. It counts as connected: cloning a second copy is the wrong answer.
    func testACheckoutAddedByHandCountsAsTheProjectsOwn() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: true, servedHere: true)],
            checkouts: ["/Users/rpo/code/my-ventures": "git@github.com:rafalpodles/ventures.git"])

        XCTAssertTrue(plan.isEmpty)
    }

    // ...and unticking that one plans to delete it, wherever it lives. The rail that would have
    // spared it was taken off deliberately; this test is what says so out loud.
    func testUntickingRemovesACheckoutOutsideTheAppsOwnFolder() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: false, servedHere: true)],
            checkouts: ["/Users/rpo/code/my-ventures": "git@github.com:rafalpodles/ventures.git"])

        XCTAssertEqual(plan.remove.map(\.path), ["/Users/rpo/code/my-ventures"])
    }

    // Reaching for it would be one failure per poll, forever, for a project the screen already
    // shows as unavailable
    func testItDoesNotTryToCloneAProjectWithNoRepository() {
        let plan = ProjectSync.plan(
            catalogue: [row("MC", repo: "", wanted: true, servedHere: false, available: false)],
            checkouts: [:])

        XCTAssertTrue(plan.isEmpty)
    }

    // An unrelated checkout is nobody's business: it belongs to no row, so no row may remove it
    func testItLeavesACheckoutNoProjectClaims() {
        let plan = ProjectSync.plan(
            catalogue: [row("BP", repo: bpRemote, wanted: true, servedHere: true)],
            checkouts: ["/checkouts/BP": bpRemote, "/Users/rpo/code/something-else": "git@github.com:o/other.git"])

        XCTAssertTrue(plan.remove.isEmpty)
    }

    func testItPlansBothDirectionsAtOnce() {
        let plan = ProjectSync.plan(
            catalogue: [
                row("BP", repo: bpRemote, wanted: false, servedHere: true),
                row("SB", repo: sbRemote, wanted: true, servedHere: false),
            ],
            checkouts: ["/checkouts/BP": bpRemote])

        XCTAssertEqual(plan.add.map(\.key), ["SB"])
        XCTAssertEqual(plan.remove.map(\.path), ["/checkouts/BP"])
    }
}
