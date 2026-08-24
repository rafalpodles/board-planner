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
        exists: @escaping Exists = { FileManager.default.fileExists(atPath: $0) },
        forget: @escaping Forget
    ) {
        self.remove = remove
        self.exists = exists
        self.forget = forget
    }

    public func perform(project: String, path: String, worktrees: [String]) -> SyncStep {
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

            if exists(path) {
                try remove(path)
            }

            // The grant goes last. Dropped first, a failed delete would leave a directory the
            // worker may no longer touch and nothing on screen explaining why.
            try forget(path)

            return .removed(project: project, path: path)
        } catch {
            return .failed(project: project, reason: error.localizedDescription)
        }
    }
}
