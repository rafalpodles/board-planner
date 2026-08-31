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

        // --ignore-submodules=none overrides `submodule.<name>.ignore = all`, which a repository
        // can ship in its own committed .gitmodules — a common setting for a large vendored
        // submodule, and one that made the parent report clean while the submodule held both
        // modified files and a commit on no remote (BP-423, measured).
        //
        // The cost is real and deliberate: a repository that ships `ignore = all` because its
        // submodule is always dirty now refuses, and its operator has done nothing wrong. Refusing
        // to delete is recoverable by hand; the other direction is not.
        let dirty = run(["-C", path, "status", "--porcelain", "--ignore-submodules=none"], path)
        guard dirty.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has uncommitted changes")
        }
        let changed = lines(dirty.output)
        if !changed.isEmpty {
            return .refused(
                reason: "\(path) has \(changed.count) uncommitted change\(changed.count == 1 ? "" : "s")")
        }

        // A stash is uncommitted work that `status` does not show, and it dies with the directory
        let stash = run(["-C", path, "stash", "list"], path)
        guard stash.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has stashed changes")
        }
        if !lines(stash.output).isEmpty {
            return .refused(reason: "\(path) has stashed changes")
        }

        // Work that exists nowhere else. `--all` rather than `--branches`: the latter is the word
        // that made a detached HEAD invisible, and an interrupted `rebase -i` — the likeliest state
        // for a checkout somebody walked away from and later unticked — leaves HEAD detached with
        // refs/heads/main still at the pushed tip and every other guard clean (BP-423, measured).
        //
        // The stash check runs first for a reason measured here: `--all` is every ref under refs/,
        // which includes refs/stash, so a single stashed change reports as "2 commits on no
        // remote". True, and the wrong sentence to hand somebody — `git stash list` is what they
        // would act on.
        let unpushed = run(["-C", path, "log", "--all", "--not", "--remotes", "--oneline"], path)
        guard unpushed.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has unpushed commits")
        }
        let commits = lines(unpushed.output)
        if !commits.isEmpty {
            return .refused(
                reason: "\(path) has \(commits.count) commit\(commits.count == 1 ? " that is" : "s that are") on no remote")
        }

        // Ignored paths hold things that exist nowhere else, and `status` says nothing about them.
        // The whole of `--ignored` cannot be the guard: measured on an ordinary clean checkout it
        // reports twenty entries — .DS_Store, .next/, .env.local — so refusing on any of them
        // refuses every real checkout on day one. And no git flag separates the .env.local, which
        // is unrecoverable, from the .DS_Store, which is noise.
        //
        // So the guard is the shape that is recoverable-work-shaped on its own terms: an ignored
        // directory that is its own git repository, holding changes or commits that are on no
        // remote. That is the `vendor/thesis` case this ticket measured, and it costs an honest
        // checkout nothing.
        //
        // Deliberately NOT covered, decided by rpo rather than assumed: a plain ignored file. A
        // stray .env in a checkout this deletes is gone, and nothing here will stop it. Said out
        // loud because the alternative is a guard set that reads as complete.
        //
        // Only the listed entry is examined, not a walk beneath it: an ignored `vendor/` holding a
        // repository at `vendor/thesis` is missed. Bounded on purpose — the listing is the cheap
        // part and a recursive search of ignored trees is not.
        let ignored = run(
            ["-C", path, "status", "--porcelain", "--ignored", "--ignore-submodules=none"], path)
        guard ignored.code == 0 else {
            return .refused(reason: "could not tell what \(path) is ignoring")
        }
        for entry in lines(ignored.output) where entry.hasPrefix("!! ") {
            let relative = String(entry.dropFirst(3))
            // Directories only, which git marks with a trailing slash. A repository is a directory,
            // and pointing a subprocess at a file as its working directory is not a no-op: the
            // spawn fails and a `waitUntilExit` on a task that never started waits for ever.
            guard relative.hasSuffix("/") else { continue }
            let nested = (path as NSString).appendingPathComponent(relative)
            guard exists(nested) else { continue }

            let top = run(["-C", nested, "rev-parse", "--show-toplevel"], nested)
            guard top.code == 0 else { continue }
            let nestedRoot = top.output.trimmingCharacters(in: .whitespacesAndNewlines)
            // Answering with the checkout means this is an ordinary ignored path inside it, not a
            // repository of its own.
            guard !sameDirectory(nestedRoot, root) else { continue }

            let nestedDirty = run(["-C", nested, "status", "--porcelain"], nested)
            let nestedUnpushed = run(["-C", nested, "log", "--all", "--not", "--remotes", "--oneline"], nested)
            let unexaminable = nestedDirty.code != 0 || nestedUnpushed.code != 0
            if unexaminable || !lines(nestedDirty.output).isEmpty || !lines(nestedUnpushed.output).isEmpty {
                return .refused(
                    reason: "\(nestedRoot) is a separate repository inside \(path), and it "
                        + (unexaminable
                            ? "could not be examined"
                            : "holds work that is on no remote"))
            }
        }

        let worktrees = run(["-C", path, "worktree", "list", "--porcelain", "-z"], path)
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
        // `git worktree lock` is a refusal an operator wrote by hand, and git's own `worktree
        // remove` honours it. This app deletes with FileManager, so without reading the `locked`
        // line it walked past the one guard a person set deliberately — and left the registration
        // behind (BP-423, measured). Unlocking is the documented way to say you meant it.
        for entry in worktreeEntries(worktrees.output, root: root) where exists(entry.path) {
            if let reason = entry.lockReason {
                return .refused(
                    reason: reason.isEmpty
                        ? "the worktree at \(entry.path) is locked"
                        : "the worktree at \(entry.path) is locked: \(reason)")
            }
        }

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

    /// Split on NUL, not newline. `-z` terminates each attribute with NUL instead of "\n", which is
    /// the only way a path containing a newline survives the listing: without it such a path spans
    /// two lines and the parser keeps the prefix — measured on real git as `…/we` out of `…/we\nird`.
    ///
    /// What that cost is worse than it sounds. The truncated path names nothing on disk, so
    /// `check`'s `exists` filter drops it and the verdict becomes `.go(worktrees: [])`: the removal
    /// then reports `.removed` — "deleted /co" — while the live worktree is still there. It is not
    /// the partial-removal case in the same ticket; it is a clean-looking success that left
    /// something behind (BP-427).
    private func fields(_ output: String) -> [String] {
        output.split(separator: "\0").map(String.init)
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
    /// BP-427 described, identity stops matching and hands the repository back, while the truncated
    /// entry is still first. The `root` filter below is unreachable for every input real git can
    /// produce, and kept because it is the one that states the intent.
    ///
    /// BP-427 has since added `-z`, so that truncation no longer happens — which removes the case
    /// that made positional the safer of the two rather than merely the simpler. Positional is kept
    /// because the property it rests on is the one measured above; the argument is recorded as it
    /// was, with its premise now narrower.
    private func linkedWorktrees(_ output: String, root: String) -> [String] {
        worktreeEntries(output, root: root).map(\.path)
    }

    /// Each linked worktree with whatever `git worktree lock` recorded for it. A record runs from a
    /// `worktree` field to the next one, so the `locked` field is read against the entry it belongs
    /// to rather than the listing as a whole — a locked main checkout would otherwise refuse every
    /// removal in the folder.
    ///
    /// `locked` with no reason is a bare field, which is why the reason is optional-but-present
    /// rather than a non-empty string: git records the lock either way.
    private func worktreeEntries(_ output: String, root: String) -> [(path: String, lockReason: String?)] {
        var entries: [(path: String, lockReason: String?)] = []
        for field in fields(output) {
            if field.hasPrefix("worktree ") {
                entries.append((String(field.dropFirst("worktree ".count)), nil))
            } else if field == "locked" || field.hasPrefix("locked ") {
                guard !entries.isEmpty else { continue }
                entries[entries.count - 1].lockReason =
                    String(field.dropFirst("locked".count)).trimmingCharacters(in: .whitespaces)
            }
        }
        // Positional, as the docblock above argues: git names the repository's main checkout first.
        return entries.dropFirst().filter { !sameDirectory($0.path, root) }
    }

    private func sameDirectory(_ a: String, _ b: String) -> Bool {
        let normalise: (String) -> String = { path in
            let standardised = (path as NSString).standardizingPath
            return standardised.hasSuffix("/") ? String(standardised.dropLast()) : standardised
        }
        return normalise(a) == normalise(b)
    }
}
