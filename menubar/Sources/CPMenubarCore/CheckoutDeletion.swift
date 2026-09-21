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
        switch await verdict(removal, path: path, busy: await isBusy()) {
        case .refused(let reason):
            return .refused(project: project, reason: reason)
        case .linkedWorktree:
            return await dropGrant(project: project, path: path)
        case .go(let worktrees):
            let doomed = doomedPaths(path: path, worktrees: worktrees)
            // Nothing is about to be deleted — the checkout went on its own and left no worktrees,
            // so all that happens is a stale grant being dropped. There is no question to ask.
            guard !doomed.isEmpty else {
                return await performOffTheActor(project: project, path: path, worktrees: worktrees)
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
            switch await verdict(removal, path: path, busy: await isBusy()) {
            case .refused(let reason):
                return .refused(project: project, reason: reason)
            case .linkedWorktree:
                return await dropGrant(project: project, path: path)
            case .go(let now):
                // The operator agreed to a list, not to a removal. Anything else on disk now is
                // something they were never shown.
                let second = doomedPaths(path: path, worktrees: now)
                guard second == doomed else {
                    // Named both ways. This line lands in the Repositories pane as something to
                    // act on, and "something changed" is not something anybody can act on.
                    return .refused(
                        project: project,
                        reason: changedReason(from: doomed, to: second))
                }
                return await performOffTheActor(project: project, path: path, worktrees: now)
            }
        }
    }

    /// Everything the operator is about to lose, in reading order: the checkout, then the worktrees
    /// that go with it. `perform` deletes in the opposite order for its own reasons; this is the
    /// list that gets named, and the list the second verdict is compared against.
    private func doomedPaths(path: String, worktrees: [String]) -> [String] {
        (exists(path) ? [path] : []) + worktrees
    }

    /// Deleting is the heavier half of the two: a recursive `removeItem` over a checkout carrying
    /// `node_modules` or a large `.git` runs for seconds. Moving only the guards off the actor
    /// would have left the menubar frozen at exactly the moment somebody has just pressed Delete
    /// and is watching to see what happens.
    private func performOffTheActor(
        project: String, path: String, worktrees: [String]
    ) async -> SyncStep {
        await Task.detached { self.perform(project: project, path: path, worktrees: worktrees) }.value
    }

    /// A linked worktree can never pass `removal`'s check — the discriminator is structural, not
    /// the checkout's current state — so leaving it refused would repeat on every reconnect for
    /// ever. Dropping the grant reaches the resolved state Preferences → Repositories → Remove
    /// already gives by hand, without deleting anything nobody asked to lose (BP-505).
    private func dropGrant(project: String, path: String) async -> SyncStep {
        await Task.detached { self.performDropGrant(project: project, path: path) }.value
    }

    private func performDropGrant(project: String, path: String) -> SyncStep {
        do {
            try forget(path)
            return .linkedWorktreeDropped(project: project, path: path)
        } catch {
            return .failed(
                project: project,
                reason: "could not drop the grant for \(path): \(error.localizedDescription)")
        }
    }

    /// `check` spawns half a dozen `git` processes and waits on each; on a large repository that
    /// is seconds, and the menubar draws on the actor this method is isolated to. Asking the
    /// question twice doubled what was already a freeze, so both looks go off it.
    private static func verdict(
        _ removal: CheckoutRemoval, path: String, busy: Bool
    ) async -> RemovalVerdict {
        await Task.detached { removal.check(path: path, workerIsBusy: busy) }.value
    }

    private func verdict(
        _ removal: CheckoutRemoval, path: String, busy: Bool
    ) async -> RemovalVerdict {
        await CheckoutDeletion.verdict(removal, path: path, busy: busy)
    }

    // The same resolution CheckoutRemoval.sameDirectory and LinkedWorktreeCheck already use —
    // matching it here rather than inventing a second way to answer "what does this path really
    // point at".
    private static func resolvedPath(_ path: String) -> String {
        ((path as NSString).standardizingPath as NSString).resolvingSymlinksInPath
    }

    private func changedReason(from before: [String], to after: [String]) -> String {
        let appeared = after.filter { !before.contains($0) }
        let vanished = before.filter { !after.contains($0) }
        var parts: [String] = []
        if !appeared.isEmpty { parts.append("\(appeared.joined(separator: ", ")) appeared") }
        if !vanished.isEmpty { parts.append("\(vanished.joined(separator: ", ")) went") }
        let what = parts.isEmpty ? "what is on disk changed" : parts.joined(separator: " and ")
        return "\(what) while the question was on screen — nothing was deleted, and it will ask again"
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
                // Resolved right before the delete, not earlier: `gone`, `forget` and the step
                // returned all still name the path the operator granted and was asked about.
                // `remove` is `FileManager.removeItem`, which deletes the directory entry it is
                // given rather than what it points to — handing it a symlink (BP-428's case,
                // which `CheckoutRemoval.check` now allows past this point) would remove only the
                // link and leave the real checkout, just confirmed for deletion, sitting on disk
                // with no grant pointing at it any more. A no-op for a path with nothing to
                // resolve, since there is nothing to follow.
                try remove(CheckoutDeletion.resolvedPath(path))
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
