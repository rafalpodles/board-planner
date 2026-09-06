import Foundation

public struct CheckoutDeletion: Sendable {
    public typealias Remove = @Sendable (String) throws -> Void
    public typealias Exists = @Sendable (String) -> Bool
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

    func perform(project: String, path: String, worktrees: [String]) -> SyncStep {
        var gone: [String] = []

        do {
            for worktree in worktrees {
                try remove(worktree)
                gone.append(worktree)
            }

            let wasThere = exists(path)
            if wasThere {
                try remove(path)
                gone.append(path)
            }

            try forget(path)

            return wasThere
                ? .removed(project: project, path: path)
                : .forgotten(project: project, path: path)
        } catch {
            return gone.isEmpty
                ? .failed(project: project, reason: error.localizedDescription)
                : .partiallyRemoved(
                    project: project, removed: gone, reason: error.localizedDescription)
        }
    }
}
