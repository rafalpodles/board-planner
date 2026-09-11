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
    /// Whether the worker is running a task, asked now rather than handed over as a value somebody
    /// sampled earlier (BP-424).
    public typealias IsBusy = @MainActor () async -> Bool
    /// Puts the whole list to the operator, on the machine, and answers whether to go ahead.
    public typealias Ask = @MainActor (_ project: String, _ paths: [String]) async -> Bool

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

    /// The whole removal: ask the guards, ask the operator, and delete only what both allowed. One
    /// entry point because the seam between guard and act used to be a call site in the app target,
    /// where nothing is tested — the list `check` returns and the list `perform` deletes could
    /// drift apart and every test would stay green.
    ///
    /// `@MainActor` because asking is what this method does, and on this machine a question is a
    /// modal on the main thread. `perform` stays off it: deleting needs nobody's attention.
    @MainActor
    public func removeIfSafe(
        project: String,
        path: String,
        isBusy: IsBusy,
        checking removal: CheckoutRemoval,
        asking ask: Ask
    ) async -> SyncStep {
        switch removal.check(path: path, workerIsBusy: await isBusy()) {
        case .refused(let reason):
            return .refused(project: project, reason: reason)
        case .go(let worktrees):
            let doomed = doomedPaths(path: path, worktrees: worktrees)
            // Nothing is about to be deleted — the checkout went on its own and left no worktrees,
            // so all that happens is a stale grant being dropped. There is no question to ask.
            guard !doomed.isEmpty else {
                return perform(project: project, path: path, worktrees: worktrees)
            }

            guard await ask(project, doomed) else {
                // Not `.refused`: a guard saying no is a fact about the checkout, and this is a
                // fact about the operator. Nothing is forgotten either, so the unticking still
                // stands and the next pass asks again.
                return .declined(project: project, paths: doomed)
            }

            // The guards above were true when they ran; the question then sat on screen for as
            // long as a person took to answer it. That is far longer than the gap BP-424 was about
            // — a worker idle before a clone and running after it — so asking once before the
            // modal would be the same bug with a longer window: a task claimed while the dialog
            // was up, and its worktree deleted underneath it.
            switch removal.check(path: path, workerIsBusy: await isBusy()) {
            case .refused(let reason):
                return .refused(project: project, reason: reason)
            case .go(let now):
                // The operator agreed to a list, not to a removal. Anything else on disk now is
                // something they were never shown.
                guard doomedPaths(path: path, worktrees: now) == doomed else {
                    return .refused(
                        project: project,
                        reason: "what is on disk changed while the question was on screen — nothing was deleted, and it will ask again")
                }
                return perform(project: project, path: path, worktrees: now)
            }
        }
    }

    /// Everything the operator is about to lose, in reading order: the checkout, then the worktrees
    /// that go with it. `perform` deletes in the opposite order for its own reasons; this is the
    /// list that gets named, and the list the second verdict is compared against.
    private func doomedPaths(path: String, worktrees: [String]) -> [String] {
        (exists(path) ? [path] : []) + worktrees
    }

    // Not public: the comment above argues for one entry point, and `internal` is what makes
    // that true rather than merely asserted. The tests reach it through @testable.
    func perform(project: String, path: String, worktrees: [String]) -> SyncStep {
        // What is already gone, in the order it went. A throw stops everything after it, and the
        // step used to name only the path that failed — so a live worktree could be destroyed and
        // the operator told about a different path entirely (BP-427). Deletion is the one act
        // nobody can undo, so the account of it is all they have.
        var gone: [String] = []

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
                gone.append(worktree)
            }

            let wasThere = exists(path)
            if wasThere {
                try remove(path)
                gone.append(path)
            }

            // The grant goes last. Dropped first, a failed delete would leave a directory the
            // worker may no longer touch and nothing on screen explaining why.
            try forget(path)

            return wasThere
                ? .removed(project: project, path: path)
                : .forgotten(project: project, path: path)
        } catch {
            // `gone` is empty only when the very first act threw, which is the case where nothing
            // happened and `.failed` is the honest word for it.
            return gone.isEmpty
                ? .failed(project: project, reason: error.localizedDescription)
                : .partiallyRemoved(
                    project: project, removed: gone, reason: error.localizedDescription)
        }
    }
}
