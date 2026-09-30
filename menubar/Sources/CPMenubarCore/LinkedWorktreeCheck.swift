import Foundation

public enum GitCheckoutKind: Equatable, Sendable {
    case repository
    case linkedWorktree
    /// The working directory of a submodule. `--git-dir` and `--git-common-dir` agree, same as an
    /// ordinary repository, so this is either git's own `--show-superproject-working-tree` naming a
    /// superproject or a git-dir under a superproject's `.git/modules/`. Deleting it leaves that
    /// superproject's gitlink pointing at a directory that is gone (BP-507).
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
    /// `nil` when an answer needed to decide could not be read. Deciding what an unexamined directory means is the
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
        guard gitDir.code == 0, commonDir.code == 0 else { return nil }

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

        // Either answer alone misses a submodule, measured on git 2.54.0 (BP-734). The git-dir's
        // `/.git/modules/` segment, which BP-507 read, is absent when the superproject's `.git` is
        // a symlink or `--separate-git-dir` (git reports `<elsewhere>/modules/vendor`, resolved) and
        // in the legacy layout (`.git`). `--show-superproject-working-tree` names the superproject
        // in all three, but it looks for a gitlink in the parent's index and answers empty, exit
        // 0, when that index is unreadable or has none — a superproject checked out to a branch
        // predating the submodule leaves `vendor/` behind, still pointing into `.git/modules/`.
        // Empty therefore means "no superproject found", not "none", and only both saying no is
        // a repository.
        if git.contains("/.git/modules/") { return .submodule }
        guard superproject.code == 0 else { return nil }
        let owner = superproject.output.trimmingCharacters(in: .whitespacesAndNewlines)
        // A git that does not know the flag echoes it and exits 0, as with `--git-common-dir`
        guard !owner.hasPrefix("-") else { return nil }
        return owner.isEmpty ? .repository : .submodule
    }
}
