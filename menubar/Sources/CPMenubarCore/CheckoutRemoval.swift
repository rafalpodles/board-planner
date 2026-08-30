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

        // The guard above cannot tell a repository from one of its linked worktrees: a worktree is
        // a work tree, `--show-toplevel` answers with the worktree's own path, and the comparison
        // just passed on a checkout looking at itself. What follows would then be asked about the
        // wrong thing — `worktree list` names the repository's main checkout first, and this used
        // to hand it back as something to delete, taking the object store every other worktree of
        // that repository shares (BP-422).
        let gitDir = run(["-C", path, "rev-parse", "--git-dir"], path)
        let commonDir = run(["-C", path, "rev-parse", "--git-common-dir"], path)
        switch LinkedWorktreeCheck.kind(gitDir: gitDir, commonDir: commonDir, relativeTo: path) {
        case .linkedWorktree:
            return .refused(
                reason: "\(path) is a linked worktree, not a repository — this removes a repository together with its worktrees, and cannot remove a worktree from the repository it belongs to. Drop it in Preferences → Repositories → Remove, which gives up the grant and deletes nothing.")
        case nil:
            return .refused(
                reason: "could not tell whether \(path) is a repository or one of its worktrees")
        case .repository:
            break
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
                reason: "\(path) has \(commits.count) commit\(commits.count == 1 ? " that is" : "s that are") on no remote")
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

        // A linked worktree has its own working tree and index, so the status check above — run in
        // the checkout — cannot see it. Refs are shared, so the unpushed and stash checks already
        // covered every worktree; uncommitted files were the half nothing covered, and the half
        // that exists nowhere else. Measured: `git status` in the checkout reports clean while a
        // worktree beside it holds a day of unsaved work (CheckoutRemovalWorktreeTests, BP-418).
        // A registration whose directory is already gone holds nothing to lose, and it is dropped
        // from the list rather than skipped inside the loop: `.go` is what the caller deletes, and
        // a path that is not there throws when it is removed. Skipping only the status check left
        // one stale entry — the ordinary result of an `rm -rf` without `git worktree prune` —
        // failing the removal on every poll, for ever, which is what the old `try?` had hidden.
        let linked = linkedWorktrees(worktrees.output, root: root).filter(exists)
        for worktree in linked {
            let dirty = run(["-C", worktree, "status", "--porcelain"], worktree)
            guard dirty.code == 0 else {
                return .refused(
                    reason: "could not tell whether the worktree at \(worktree) has uncommitted changes")
            }
            let changed = lines(dirty.output)
            if !changed.isEmpty {
                return .refused(
                    reason: "the worktree at \(worktree) has \(changed.count) uncommitted change\(changed.count == 1 ? "" : "s")")
            }
        }

        return .go(worktrees: linked)
    }

    private func lines(_ output: String) -> [String] {
        output.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    /// Every `worktree <path>` line except the checkout itself — and except the repository's main
    /// checkout, which `git worktree list` always names first.
    ///
    /// Dropping `root` alone was the whole of BP-422: asked about a linked worktree, `root` *is*
    /// that worktree, so the main checkout survived the filter and came back as something to
    /// delete. `check` refuses that case before this runs, so this is the second line rather than
    /// the fix — and it is positional, not intrinsic: it holds because git names the main worktree
    /// first, which `testWorktreeListNamesTheMainCheckoutFirstEvenFromAWorktree` pins and the
    /// BP-422 review measured across a locked worktree, a prunable entry mid-list, four
    /// registrations, and after `worktree move` and `prune`.
    ///
    /// Positional was chosen over deriving the main checkout from `--git-common-dir` and filtering
    /// it by identity, which reads like the stronger guard and is not: fed the truncated listing
    /// BP-427 describes, identity stops matching and hands the repository back, while the truncated
    /// entry is still first. The `root` filter below is unreachable for every input real git can
    /// produce, and kept because it is the one that states the intent.
    private func linkedWorktrees(_ output: String, root: String) -> [String] {
        lines(output)
            .compactMap { line in
                line.hasPrefix("worktree ") ? String(line.dropFirst("worktree ".count)) : nil
            }
            .dropFirst()
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
