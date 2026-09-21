import Foundation

/// Whether a directory the operator just chose may be added to the allowlist a picker writes to
/// `repos.json`.
///
/// The picker used to write whatever was chosen with no check at all, and a linked worktree sits
/// right beside its checkout in the very folder a picker opens on — the likeliest way one was
/// granted in the first place (BP-505). `CloneStep` and `CheckoutRemoval` already refuse to touch
/// a granted linked worktree; this is the third place that reads the same discriminator, at the
/// point granting it could still be refused instead of merely survived.
///
/// A `switch` rather than the `== .linkedWorktree` equality this used to be, deliberately: an
/// equality check does not ask the compiler to prove every case was considered, which is exactly
/// how BP-507's `.submodule` case reached `CloneStep` and `CheckoutRemoval` — both already
/// `switch`es — while this file kept silently answering `.allowed` for it (found reviewing that
/// same ticket). A submodule granted here is a directory `CheckoutRemoval` will later refuse to
/// delete standalone, the same shape of problem BP-505 introduced this check to avoid for a linked
/// worktree.
public enum CheckoutGrant: Equatable, Sendable {
    case allowed
    case refused(reason: String)

    public static func check(
        path: String,
        run: (_ args: [String], _ cwd: String) -> (code: Int32, output: String)
    ) -> CheckoutGrant {
        let gitDir = run(["-C", path, "rev-parse", "--git-dir"], path)
        let commonDir = run(["-C", path, "rev-parse", "--git-common-dir"], path)
        switch LinkedWorktreeCheck.kind(gitDir: gitDir, commonDir: commonDir, relativeTo: path) {
        case .linkedWorktree:
            return .refused(
                reason:
                    "\(path) is a linked worktree of another checkout, not a repository of its own. Point this project at a folder of its own.")
        case .submodule:
            return .refused(
                reason:
                    "\(path) is a submodule's working directory, not a repository of its own. Point this project at a folder of its own.")
        case nil, .repository:
            // Unexamined (nil) is answered the same as .repository here, as it always has been:
            // this check only ever refused a positively identified linked worktree or submodule,
            // never a directory git simply would not describe.
            return .allowed
        }
    }
}
