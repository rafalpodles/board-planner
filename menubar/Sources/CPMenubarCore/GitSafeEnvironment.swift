import Foundation

/// What a git the app spawns must not inherit. The counterpart of the worker's own hardening
/// (`worker/src/delivery.ts`), deliberately smaller.
///
/// `core.gitProxy` is the reason this exists at all rather than living in `-c` flags beside the
/// rest: git keeps the **first** value it is given for that key, so the operator's `~/.gitconfig`
/// outranks any command-line override. The environment is the one layer that wins, and an empty
/// value there means "no proxy" rather than "fall through to the config". Measured on git 2.50.1
/// through the app's own spawn path: a `url.*.insteadOf` rewriting `https://` to `git://` made a
/// plain, well-formed https remote reach a program of the config's choosing, and this stopped it.
///
/// The four `GIT_*` redirects are the BP-422 review's finding, and they cut both ways, measured
/// through this app's own spawn path: `GIT_COMMON_DIR` pointing elsewhere makes a healthy
/// repository read as a linked worktree and refuses to remove it, and `GIT_DIR` pointing at any
/// clean repository makes every question the removal guard asks get answered about *that* one
/// while the path it authorises for deletion is still the one it was given. A GUI launched from
/// Finder inherits none of them; a developer's terminal, and `swift run`, do.
///
/// `~/.gitconfig` itself is deliberately left readable, which is where this parts company with the
/// worker: delivery drops it because the agent shares that filesystem, whereas this runs during
/// onboarding, and dropping it would take the operator's credential helper and any `core.sshCommand`
/// deploy key with it — at the one moment a failure is hardest to tell apart from a typo.
public enum GitSafeEnvironment {
    public static func apply(to environment: [String: String]) -> [String: String] {
        var hardened = environment
        hardened["GIT_CONFIG_NOSYSTEM"] = "1"
        hardened["GIT_PROXY_COMMAND"] = ""
        // Removed rather than emptied: an empty GIT_DIR is not "unset", it is a git dir named "".
        for redirect in ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
            hardened.removeValue(forKey: redirect)
        }
        return hardened
    }
}
