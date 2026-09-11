import Foundation

/// Whether a catalogue that arrived while a pass was running is worth another pass.
///
/// One decision, in Core rather than in the runner, for the reason `CheckoutDeletion` and
/// `SyncPass` are here: the app target carries no tests, and the first version of this loop put a
/// declined confirmation's dialog straight back on screen.
public enum CatalogueQueue {
    /// What to run after a pass over `done`, given whatever arrived during it.
    ///
    /// An identical catalogue carries no new work — the plan it produces is the plan just acted on,
    /// so draining it would re-ask a question the operator has just answered. The slot exists to
    /// catch a *changed* catalogue, which is a project ticked or unticked while a confirmation sat
    /// on screen; that one must not wait for the next reconnect.
    public static func next(
        after done: [ProjectCatalogueRow], arrived pending: [ProjectCatalogueRow]?
    ) -> [ProjectCatalogueRow]? {
        guard let pending, pending != done else { return nil }
        return pending
    }
}
