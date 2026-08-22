import Foundation

// Whether a checkout may be deleted, and what has to go with it. Deleting a directory is the one
// thing here nobody can undo, so this answers with a refusal by default: every check that cannot
// be run counts as a no. A directory that is not a git checkout, or a git that will not answer,
// is not "clean" — it is unexamined, and the difference matters exactly once.
public enum RemovalVerdict: Equatable {
    /// Safe to remove. `worktrees` are the linked worktrees to take with it — they live beside the
    /// checkout under a shared `cp-worktrees` root, so deleting that root wholesale would take
    /// another project's worktrees with it.
    case go(worktrees: [String])
    case refused(reason: String)
}

public struct CheckoutRemoval: Sendable {
    public typealias RunGit = @Sendable (_ args: [String], _ cwd: String) -> (code: Int32, output: String)

    private let run: RunGit
    private let exists: @Sendable (String) -> Bool

    public init(
        run: @escaping RunGit,
        exists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) {
        self.run = run
        self.exists = exists
    }

    public func check(path: String, workerIsBusy: Bool) -> RemovalVerdict {
        // First because it is true regardless of what the directory looks like, and because the
        // worker holds files open in there — a run whose worktree vanishes fails in ways that read
        // as anything but "somebody deleted it".
        if workerIsBusy {
            return .refused(reason: "the worker is running a task — stop it, or wait for it to finish")
        }

        // Already gone. The allowlist entry still has to go, and there is nothing to delete.
        guard exists(path) else { return .go(worktrees: []) }

        let toplevel = run(["-C", path, "rev-parse", "--show-toplevel"], path)
        guard toplevel.code == 0 else {
            return .refused(
                reason: "\(path) is not a git checkout, or git could not read it — refusing to delete a directory this app cannot examine")
        }
        // The allowlist entry is a path, and a path can be a subdirectory of a checkout. Deleting
        // one of those takes part of a repository rather than the repository.
        let root = toplevel.output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sameDirectory(root, path) else {
            return .refused(reason: "\(path) is inside the checkout at \(root), not the checkout itself")
        }

        let dirty = run(["-C", path, "status", "--porcelain"], path)
        guard dirty.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has uncommitted changes")
        }
        let changed = lines(dirty.output)
        if !changed.isEmpty {
            return .refused(
                reason: "\(path) has \(changed.count) uncommitted change\(changed.count == 1 ? "" : "s")")
        }

        // Work that exists nowhere else. `--branches --not --remotes` catches both a branch ahead
        // of its upstream and a branch that never had one — the second being the case a plain
        // ahead/behind check misses, and the likelier one on a machine that writes branches.
        let unpushed = run(["-C", path, "log", "--branches", "--not", "--remotes", "--oneline"], path)
        guard unpushed.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has unpushed commits")
        }
        let commits = lines(unpushed.output)
        if !commits.isEmpty {
            return .refused(
                reason: "\(path) has \(commits.count) commit\(commits.count == 1 ? "" : "s") that are on no remote")
        }

        // A stash is uncommitted work that `status` does not show, and it dies with the directory
        let stash = run(["-C", path, "stash", "list"], path)
        guard stash.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has stashed changes")
        }
        if !lines(stash.output).isEmpty {
            return .refused(reason: "\(path) has stashed changes")
        }

        let worktrees = run(["-C", path, "worktree", "list", "--porcelain"], path)
        guard worktrees.code == 0 else {
            return .refused(reason: "could not list the worktrees of \(path)")
        }

        return .go(worktrees: linkedWorktrees(worktrees.output, root: root))
    }

    private func lines(_ output: String) -> [String] {
        output.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    /// Every `worktree <path>` line except the checkout itself.
    private func linkedWorktrees(_ output: String, root: String) -> [String] {
        lines(output)
            .compactMap { line in
                line.hasPrefix("worktree ") ? String(line.dropFirst("worktree ".count)) : nil
            }
            .filter { !sameDirectory($0, root) }
    }

    private func sameDirectory(_ a: String, _ b: String) -> Bool {
        let normalise: (String) -> String = { path in
            let standardised = (path as NSString).standardizingPath
            return standardised.hasSuffix("/") ? String(standardised.dropLast()) : standardised
        }
        return normalise(a) == normalise(b)
    }
}
