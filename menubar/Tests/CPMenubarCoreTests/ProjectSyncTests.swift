import XCTest
@testable import CPMenubarCore

final class ProjectSyncTests: XCTestCase {
    // The name is not the key, and is deliberately not derived from it: every message under test
    // reads one of the two, and a fixture where they are the same string cannot say which
    // (found in review).
    private static let names = ["SB": "Ventures", "BP": "Board Planner"]

    private func row(
        _ key: String, repo: String, wanted: Bool, servedHere: Bool, available: Bool = true
    ) -> ProjectCatalogueRow {
        ProjectCatalogueRow(
            project: "p-\(key)", key: key, name: Self.names[key] ?? "The \(key) project",
            repositoryUrl: repo,
            available: available, workersEnabled: true, servedHere: servedHere, wanted: wanted)
    }

    private let bpRemote = "git@github.com:owner/board-planner.git"
    private let sbRemote = "https://github.com/owner/ventures"

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
            checkouts: ["/Users/owner/code/my-ventures": "git@github.com:owner/ventures.git"])

        XCTAssertTrue(plan.isEmpty)
    }

    // ...and unticking that one plans to delete it, wherever it lives. The rail that would have
    // spared it was taken off deliberately; this test is what says so out loud.
    func testUntickingRemovesACheckoutOutsideTheAppsOwnFolder() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: false, servedHere: true)],
            checkouts: ["/Users/owner/code/my-ventures": "git@github.com:owner/ventures.git"])

        XCTAssertEqual(plan.remove.map(\.path), ["/Users/owner/code/my-ventures"])
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
            checkouts: ["/checkouts/BP": bpRemote, "/Users/owner/code/something-else": "git@github.com:o/other.git"])

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

    // BP-602. The guard is right — there is nowhere to clone to — but it returned in silence, so
    // the operator ticked a project, was told the app would pick it up, and then read a healthy
    // fleet screen, an empty Repositories pane and a row that never connected.
    func testItSaysSoWhenThereIsNowhereToPutWhatWasPicked() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: true, servedHere: false)],
            checkouts: [:])

        let step = ProjectSync.nowhereToPut(plan: plan, checkoutsFolder: "")

        // "Ventures", not "SB": the pane is read by whoever set the machine up, and the name is
        // what they picked the project by on the board
        XCTAssertEqual(step, .nowhereToPut(projects: ["Ventures"], where: checkoutsFolderLocation))
    }

    // The message names where the folder is set, not only that it is missing.
    func testItNamesWhereTheFolderIsSet() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: true, servedHere: false)],
            checkouts: [:])

        guard case .nowhereToPut(_, let location)? =
            ProjectSync.nowhereToPut(plan: plan, checkoutsFolder: "") else {
            return XCTFail("no step")
        }

        // Somewhere that exists and can actually set it: Preferences has no tab that writes this
        // folder, and naming one would send the operator looking for a screen that is not there.
        XCTAssertTrue(location.contains("setup screen"))
        XCTAssertFalse(location.contains("Preferences"))
    }

    // A removal needs no folder, but the pass returns before it too, so naming only the clones
    // would describe half of what did not happen.
    func testItNamesTheRemovalsItCouldNotActOnEither() {
        let plan = ProjectSync.plan(
            catalogue: [row("BP", repo: bpRemote, wanted: false, servedHere: true)],
            checkouts: ["/checkouts/BP": bpRemote])

        XCTAssertEqual(
            ProjectSync.nowhereToPut(plan: plan, checkoutsFolder: ""),
            .nowhereToPut(projects: ["Board Planner"], where: checkoutsFolderLocation))
    }

    // A machine nobody has given a project to is not misconfigured, it is unused.
    func testItSaysNothingWhenThereWasNothingToDo() {
        XCTAssertNil(
            ProjectSync.nowhereToPut(plan: SyncPlan(add: [], remove: []), checkoutsFolder: ""))
    }

    // The control: a machine that has a folder is not told it has none, whitespace included.
    func testItSaysNothingWhenTheFolderIsSet() {
        let plan = ProjectSync.plan(
            catalogue: [row("SB", repo: sbRemote, wanted: true, servedHere: false)],
            checkouts: [:])

        XCTAssertNil(ProjectSync.nowhereToPut(plan: plan, checkoutsFolder: "/checkouts"))
        XCTAssertNotNil(ProjectSync.nowhereToPut(plan: plan, checkoutsFolder: "   "))
    }

    // The one step that is a condition rather than an event: it stops being true the moment a
    // folder is chosen, and a pane still showing it above "Set up SB in …" contradicts itself.
    func testItRetractsTheWarningOnceThereIsSomewhereToPut() {
        let steps: [SyncStep] = [
            .added(project: "BP", path: "/checkouts/BP"),
            .nowhereToPut(projects: ["SB"], where: checkoutsFolderLocation),
        ]

        XCTAssertEqual(
            ProjectSync.withoutNowhereToPut(steps), [.added(project: "BP", path: "/checkouts/BP")])
    }

    // Ticking a second project renames the condition, and a dedupe by value read that as a second
    // condition: the pane held both lines, the older one describing a state that was over.
    func testItReplacesTheBlockedLineRatherThanAddingASecondOne() {
        let first: SyncStep = .nowhereToPut(projects: ["Recurro"], where: checkoutsFolderLocation)
        let second: SyncStep = .nowhereToPut(
            projects: ["Recurro", "Atlas"], where: checkoutsFolderLocation)

        let steps = ProjectSync.replacingNowhereToPut(
            [.added(project: "BP", path: "/a"), first], with: second)

        XCTAssertEqual(steps, [.added(project: "BP", path: "/a"), second])
    }

    // What the runner's "only when it changed" guard is allowed to rely on: an unchanged condition
    // rebuilds to an equal list, so a pass that says nothing new writes nothing.
    func testAnUnchangedBlockedLineRebuildsToTheSameSteps() {
        let blocked: SyncStep = .nowhereToPut(projects: ["Recurro"], where: checkoutsFolderLocation)
        let steps: [SyncStep] = [.added(project: "BP", path: "/a"), blocked]

        XCTAssertEqual(ProjectSync.replacingNowhereToPut(steps, with: blocked), steps)
    }

    // Every other line is a thing that happened and stays true, so none of them is dropped.
    func testItKeepsEveryStepThatRecordsSomethingThatHappened() {
        let steps: [SyncStep] = [
            .added(project: "BP", path: "/a"),
            .removed(project: "SB", path: "/b"),
            .forgotten(project: "X", path: "/c"),
            .refused(project: "Y", reason: "busy"),
            .declined(project: "Z", paths: ["/d"]),
            .partiallyRemoved(project: "W", removed: ["/e"], reason: "stopped"),
            .failed(project: "V", reason: "no"),
        ]

        XCTAssertEqual(ProjectSync.withoutNowhereToPut(steps), steps)
    }

    // MARK: - BP-505: a refusal that repeats every reconnect does not pile up

    // The project stays unwanted and held, so an unresolved refusal runs again next reconnect and,
    // unless something about the checkout changed, says exactly the same sentence. Appended
    // plainly, that is a line added per reconnect for as long as the operator leaves it be.
    func testAnIdenticalRefusalIsNotAppendedTwice() {
        let refusal: SyncStep = .refused(project: "BP", reason: "3 uncommitted changes")

        XCTAssertEqual(
            ProjectSync.appending(refusal, to: [refusal]), [refusal],
            "the same guard saying the same thing again names nothing new")
    }

    // The control: a changed reason is a changed fact about the checkout, and belongs on its own
    // line rather than being swallowed by a dedupe keyed on the project alone.
    func testARefusalWithADifferentReasonStillJoinsTheList() {
        let first: SyncStep = .refused(project: "BP", reason: "3 uncommitted changes")
        let second: SyncStep = .refused(project: "BP", reason: "5 uncommitted changes")

        XCTAssertEqual(ProjectSync.appending(second, to: [first]), [first, second])
    }

    // The other control: every non-refusal case is an event, and two identical events are two
    // events. Without this, widening the dedupe to every case would still pass the test above.
    func testAnOrdinaryStepIsAppendedEvenWhenItRepeatsExactly() {
        let added: SyncStep = .added(project: "BP", path: "/checkouts/BP")

        XCTAssertEqual(ProjectSync.appending(added, to: [added]), [added, added])
    }
}
