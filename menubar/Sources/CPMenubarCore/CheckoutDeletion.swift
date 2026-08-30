import Foundation

/// The irreversible half of a project removal, once `CheckoutRemoval` has said yes.
///
/// Three acts in an order that matters, extracted from `ProjectSyncRunner` so that order can be
/// asserted: the app target carries no tests, and this is where the part nobody can undo lives.
public struct CheckoutDeletion: Sendable {
    public typealias Remove = @Sendable (String) throws -> Void
    public typealias Exists = @Sendable (String) -> Bool
    /// Drops the path from the allowlist. Separate from `remove` because it is the one act that
    /// leaves the disk alone.
    public typealias Forget = @Sendable (String) throws -> Void

    private let remove: Remove
    private let exists: Exists
    private let forget: Forget

    public init(
        remove: @escaping Remove,
        exists: @escaping Exists,
        forget: @escaping Forget
    ) {
        self.remove = remove
        self.exists = exists
        self.forget = forget
    }

    /// The whole removal: ask the guards, and delete only what they allowed. One entry point
    /// because the seam between the two used to be a call site in the app target, where nothing
    /// is tested — the list `check` returns and the list `perform` deletes could drift apart and
    /// every test would stay green.
    public func removeIfSafe(
        project: String,
        path: String,
        workerIsBusy: Bool,
        checking removal: CheckoutRemoval
    ) -> SyncStep {
        switch removal.check(path: path, workerIsBusy: workerIsBusy) {
        case .refused(let reason):
            return .refused(project: project, reason: reason)
        case .go(let worktrees):
            return perform(project: project, path: path, worktrees: worktrees)
        }
    }

    // Not public: the comment above argues for one entry point, and `internal` is what makes
    // that true rather than merely asserted. The tests reach it through @testable.
    func perform(project: String, path: String, worktrees: [String]) -> SyncStep {
        do {
            // The worktrees first: they live beside the checkout, under a root shared with every
            // other project in that folder, so they are removed by name rather than by deleting
            // the root they sit in.
            //
            // A throw here stops everything after it. Before BP-418 this was `try?`, so a worktree
            // that would not delete left no step at all and the run went on to report `.removed`
            // naming the checkout — true, and read as "all of it went".
            for worktree in worktrees {
                try remove(worktree)
            }

            let wasThere = exists(path)
            if wasThere {
                try remove(path)
            }

            // The grant goes last. Dropped first, a failed delete would leave a directory the
            // worker may no longer touch and nothing on screen explaining why.
            try forget(path)

            return wasThere
                ? .removed(project: project, path: path)
                : .forgotten(project: project, path: path)
        } catch {
            return .failed(project: project, reason: error.localizedDescription)
        }
    }
}
