import Foundation

public enum GitCheckoutKind: Equatable, Sendable {
    case repository
    case linkedWorktree
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
    /// the caller's, and both callers here answer it the same way: no.
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
        return git == common ? .repository : .linkedWorktree
    }
}
