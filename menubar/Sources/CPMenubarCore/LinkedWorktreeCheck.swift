import Foundation

public enum GitCheckoutKind: Equatable, Sendable {
    case repository
    case linkedWorktree
    /// The working directory of a submodule. `--git-dir` and `--git-common-dir` agree, same as an
    /// ordinary repository — but the agreed path lives under the superproject's `.git/modules/`,
    /// not under this directory's own `.git`. Its objects live in the superproject and are not
    /// lost if this directory goes; the superproject's gitlink is, left pointing at a directory
    /// that is gone (BP-507).
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
    /// `nil` when either answer could not be read. Deciding what an unexamined directory means is
    /// the caller's: refusing an irreversible act on it (`CloneStep` adopting one, `CheckoutRemoval`
    /// deleting one) answers no; granting it access (`CheckoutGrant`, BP-505) is not irreversible,
    /// and answers yes — the picker accepted every such folder before this discriminator existed
    /// too, and widening that is a decision for its own ticket.
    public static func kind(
        gitDir: (code: Int32, output: String),
        commonDir: (code: Int32, output: String),
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
        return isSubmoduleGitDir(git) ? .submodule : .repository
    }

    /// Git's own convention for where a submodule's git-dir lives: always a `modules/<name>` child
    /// of the superproject's `.git`, never a directory's own `.git`. Measured on git 2.50.1 — a
    /// nested submodule's git-dir nests the same way (`.git/modules/<outer>/modules/<inner>`), so
    /// containment rather than a suffix match is what generalises to it.
    private static func isSubmoduleGitDir(_ resolved: String) -> Bool {
        resolved.contains("/.git/modules/")
    }
}
