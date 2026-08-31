import Foundation

/// One pass over a `SyncPlan`: the clones, then the deletions, in that order.
///
/// Extracted from `ProjectSyncRunner` for the reason `CheckoutDeletion` already gives — the app
/// target carries no tests — and because the order it runs in is the bug. `busy` used to arrive as
/// a `Bool` sampled by the caller before the pass began, with a comment saying a stale copy of it
/// "is the difference between a refusal and deleting a worktree out from under a run". A clone
/// takes minutes, so by the time the deletions were reached that copy was exactly what the comment
/// warned against: a worker idle at the start, given a task during the clone, had its checkout
/// deleted underneath it (BP-424).
///
/// So it arrives as a question instead of an answer, and the question is asked again before each
/// removal — not once before the loop, because removals take time too and a worker can pick up a
/// task between two of them.
@MainActor
public enum SyncPass {
    public typealias Add = (ProjectOffer) async -> Result<String, ProjectSetup.Failure>
    /// Whether the worker is running a task, asked now.
    public typealias IsBusy = () async -> Bool

    /// Turns "what is the worker doing" into "may I delete this". Lives here rather than at the
    /// call site so the answer to an unanswerable question is testable: a socket that will not
    /// reply counts as **busy**. That is `CheckoutRemoval`'s own rule — every check that cannot be
    /// run is a no — and the alternative is deleting a checkout on the strength of not knowing.
    ///
    /// Written as a `guard` rather than `(try? await status())?.current != nil`, which collapses a
    /// failed request and an idle worker into the same answer, and the wrong one.
    public static func busy(asking status: @escaping () async throws -> StatusResponse) -> IsBusy {
        {
            guard let now = try? await status() else { return true }
            return now.current != nil
        }
    }

    public static func run(
        plan: SyncPlan,
        add: Add,
        isBusy: IsBusy,
        deletion: CheckoutDeletion,
        removal: CheckoutRemoval,
        onStep: (SyncStep) -> Void
    ) async {
        for offer in plan.add {
            switch await add(offer) {
            case .success(let path):
                onStep(.added(project: offer.label, path: path))
            case .failure(.clone(let reason)), .failure(.grant(let reason)):
                onStep(.failed(project: offer.label, reason: reason))
            }
        }

        for planned in plan.remove {
            onStep(
                deletion.removeIfSafe(
                    project: planned.project.label,
                    path: planned.path,
                    workerIsBusy: await isBusy(),
                    checking: removal))
        }
    }
}
