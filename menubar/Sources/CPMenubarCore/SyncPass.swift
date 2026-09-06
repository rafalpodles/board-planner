import Foundation

@MainActor
public enum SyncPass {
    public typealias Add = (ProjectOffer) async -> Result<String, ProjectSetup.Failure>
    public typealias IsBusy = () async -> Bool

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
