import XCTest
@testable import CPMenubarCore

/// BP-378. Detaching the pass from the socket pump let a catalogue arrive while a confirmation was
/// on screen, and the first version of the slot that caught it drained unconditionally — so a
/// reconnect during the modal put the same dialog straight back up after the operator had said no.
final class CatalogueQueueTests: XCTestCase {
    private func row(_ key: String, wanted: Bool) -> ProjectCatalogueRow {
        ProjectCatalogueRow(
            project: key, key: key, name: "", repositoryUrl: "https://example.test/\(key).git",
            available: true, workersEnabled: true, servedHere: true, wanted: wanted)
    }

    func testNothingArrivedMeansNothingToRun() {
        XCTAssertNil(CatalogueQueue.next(after: [row("BP", wanted: false)], arrived: nil))
    }

    /// The bug. The same catalogue produces the same plan, so running it again re-asks a question
    /// that was just answered — and `.declined` deliberately leaves the unticking standing, so the
    /// plan really is identical every time.
    func testTheSameCatalogueAgainIsNotWorthAPass() {
        let same = [row("BP", wanted: false)]

        XCTAssertNil(CatalogueQueue.next(after: same, arrived: same))
    }

    /// The reason the slot exists at all: somebody ticked a project while the confirmation sat
    /// there, and that must not wait for the next reconnect — days, on a healthy worker.
    func testAChangedCatalogueIsRunAtOnce() {
        let before = [row("BP", wanted: false)]
        let after = [row("BP", wanted: false), row("NEW", wanted: true)]

        XCTAssertEqual(CatalogueQueue.next(after: before, arrived: after), after)
    }

    /// The narrower half of the same thing: the set of projects is unchanged and only a tick moved.
    /// Comparing by count, or by project ids, would call this identical and drop it.
    func testATickThatFlippedOnTheSameProjectStillCounts() {
        let before = [row("BP", wanted: false)]
        let after = [row("BP", wanted: true)]

        XCTAssertEqual(CatalogueQueue.next(after: before, arrived: after), after)
    }
}
