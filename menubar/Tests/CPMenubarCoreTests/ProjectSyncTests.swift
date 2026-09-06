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

    func testItDoesNothingWhenTheDiskAlreadyAgrees() {
        let plan = ProjectSync.plan(
            catalogue: [
                row("BP", repo: bpRemote, wanted: true, servedHere: true),
                row("SB", repo: sbRemote, wanted: false, servedHere: false),
            ],
            checkouts: ["/checkouts/BP": bpRemote])

        XCTAssertTrue(plan.isEmpty)
    }

    func testACheckoutAddedByHandCountsAsTheProjectsOwn() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: true, servedHere: true)],
            checkouts: ["/Users/rpo/code/my-ventures": "git@github.com:rafalpodles/ventures.git"])

        XCTAssertTrue(plan.isEmpty)
    }

    func testUntickingRemovesACheckoutOutsideTheAppsOwnFolder() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: false, servedHere: true)],
            checkouts: ["/Users/rpo/code/my-ventures": "git@github.com:rafalpodles/ventures.git"])

        XCTAssertEqual(plan.remove.map(\.path), ["/Users/rpo/code/my-ventures"])
    }

    func testItDoesNotTryToCloneAProjectWithNoRepository() {
        let plan = ProjectSync.plan(
            catalogue: [row("MC", repo: "", wanted: true, servedHere: false, available: false)],
            checkouts: [:])

        XCTAssertTrue(plan.isEmpty)
    }

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
