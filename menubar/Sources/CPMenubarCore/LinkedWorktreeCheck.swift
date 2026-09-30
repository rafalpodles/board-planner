import Foundation

public enum GitCheckoutKind: Equatable, Sendable {
    case repository
    case linkedWorktree
    /// The working directory of a submodule. `--git-dir` and `--git-common-dir` agree, same as an
    /// ordinary repository, so this is git's own `--show-superproject-working-tree` naming a
    /// superproject. Deleting it leaves that superproject's gitlink pointing at a directory that is
    /// gone (BP-507).
    case submodule
}

/// Telling a repository from one of its linked worktrees.
///
/// Nothing that reads `rev-parse --show-toplevel` can: a linked worktree *is* a work tree, and it
/// answers with its own path, so a guard comparing that against the path it was given sees a
/// checkout looking at itself. The pair that differs is `--git-dir` and `--git-common-dir` — the
/// same directory in a repository, and in a worktree the repository's `.git` against
/// `<that>/worktrees/<name>`.
///
/// This matters because the repository's `.git` holds the object store every worktree of it shares,
/// so deleting it takes them all, including ones nobody named (BP-422).
public enum LinkedWorktreeCheck {
    /// `nil` when any answer could not be read. Deciding what an unexamined directory means is the
    /// caller's: refusing an irreversible act on it (`CloneStep` adopting one, `CheckoutRemoval`
    /// deleting one) answers no; granting it access (`CheckoutGrant`, BP-505) is not irreversible,
    /// and answers yes — the picker accepted every such folder before this discriminator existed
    /// too, and widening that is a decision for its own ticket.
    ///
    /// `run` takes `git` arguments and runs them however the caller runs git — every caller's
    /// runner is the resolved absolute path and `GitSafeEnvironment` (BP-733).
    public static func kind(
        of path: String,
        run: (_ args: [String]) -> (code: Int32, output: String)
    ) -> GitCheckoutKind? {
        kind(
            gitDir: run(["-C", path, "rev-parse", "--git-dir"]),
            commonDir: run(["-C", path, "rev-parse", "--git-common-dir"]),
            superproject: run(["-C", path, "rev-parse", "--show-superproject-working-tree"]),
            relativeTo: path)
    }

    public static func kind(
        gitDir: (code: Int32, output: String),
        commonDir: (code: Int32, output: String),
        superproject: (code: Int32, output: String),
        relativeTo path: String
    ) -> GitCheckoutKind? {
        guard gitDir.code == 0, commonDir.code == 0, superproject.code == 0 else { return nil }

        // git answers relative to the directory it was run in when the git dir is itself relative —
        // `.git` for an ordinary checkout, absolute for a worktree — so both are resolved against
        // the path before they are compared, rather than compared as the strings they arrived as
        let resolve: (String) -> String? = { answer in
            let trimmed = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            // `git rev-parse` echoes an option it does not know and exits 0, so on a git without
            // `--git-common-dir` the answer is the flag itself. That is not a path, and the exit
            // code alone would have let it through as one (BP-422 review).
            guard !trimmed.isEmpty, !trimmed.hasPrefix("-") else { return nil }
            let absolute = trimmed.hasPrefix("/")
                ? trimmed
                : (path as NSString).appendingPathComponent(trimmed)
            return ((absolute as NSString).standardizingPath as NSString).resolvingSymlinksInPath
        }

        guard let git = resolve(gitDir.output), let common = resolve(commonDir.output) else {
            return nil
        }
        guard git == common else { return .linkedWorktree }

        // Not the git-dir's `/.git/modules/` segment, which BP-507 read: git reports the git-dir
        // resolved, so a superproject whose `.git` is a symlink or `--separate-git-dir` answers
        // `<elsewhere>/modules/vendor`, and a legacy submodule with its own `.git` directory answers
        // `.git`. `--show-superproject-working-tree` asks the parent directory's index for a gitlink
        // at this path instead, and named the superproject in all three on git 2.54.0 (BP-734).
        // Empty is git's answer for "no superproject". A git that does not know the flag echoes it
        // and exits 0, as with `--git-common-dir` above, so that is refused the same way.
        let owner = superproject.output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !owner.hasPrefix("-") else { return nil }
        return owner.isEmpty ? .repository : .submodule
    }
}
