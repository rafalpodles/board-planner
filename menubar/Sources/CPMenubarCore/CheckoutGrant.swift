import Foundation

/// Whether a directory the operator just chose may be added to the allowlist a picker writes to
/// `repos.json`.
///
/// The picker used to write whatever was chosen with no check at all, and a linked worktree sits
/// right beside its checkout in the very folder a picker opens on — the likeliest way one was
/// granted in the first place (BP-505). `CloneStep` and `CheckoutRemoval` already refuse to touch
/// a granted linked worktree; this is the third place that reads the same discriminator, at the
/// point granting it could still be refused instead of merely survived.
public enum CheckoutGrant: Equatable, Sendable {
    case allowed
    case refused(reason: String)

    public static func check(
        path: String,
        run: (_ args: [String], _ cwd: String) -> (code: Int32, output: String)
    ) -> CheckoutGrant {
        let gitDir = run(["-C", path, "rev-parse", "--git-dir"], path)
        let commonDir = run(["-C", path, "rev-parse", "--git-common-dir"], path)
        guard LinkedWorktreeCheck.kind(gitDir: gitDir, commonDir: commonDir, relativeTo: path) == .linkedWorktree
        else {
            return .allowed
        }
        return .refused(
            reason:
                "\(path) is a linked worktree of another checkout, not a repository of its own. Point this project at a folder of its own.")
    }
}
