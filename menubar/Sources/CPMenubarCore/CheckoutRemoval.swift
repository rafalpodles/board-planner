import Foundation

public enum RemovalVerdict: Equatable {
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
        if workerIsBusy {
            return .refused(reason: "the worker is running a task — stop it, or wait for it to finish")
        }

        guard exists(path) else { return .go(worktrees: []) }

        let toplevel = run(["-C", path, "rev-parse", "--show-toplevel"], path)
        guard toplevel.code == 0 else {
            return .refused(
                reason: "\(path) is not a git checkout, or git could not read it — refusing to delete a directory this app cannot examine")
        }
        let root = toplevel.output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sameDirectory(root, path) else {
            return .refused(reason: "\(path) is inside the checkout at \(root), not the checkout itself")
        }

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

        let dirty = run(["-C", path, "status", "--porcelain", "--ignore-submodules=none"], path)
        guard dirty.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has uncommitted changes")
        }
        let changed = lines(dirty.output)
        if !changed.isEmpty {
            return .refused(
                reason: "\(path) has \(changed.count) uncommitted change\(changed.count == 1 ? "" : "s")")
        }

        let stash = run(["-C", path, "stash", "list"], path)
        guard stash.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has stashed changes")
        }
        if !lines(stash.output).isEmpty {
            return .refused(reason: "\(path) has stashed changes")
        }

        let unpushed = run(
            [
                "-C", path, "log", "--exclude=refs/prefetch/*", "--exclude=refs/notes/*",
                "--all", "--not", "--remotes", "--oneline",
            ], path)
        guard unpushed.code == 0 else {
            return .refused(reason: "could not tell whether \(path) has unpushed commits")
        }
        let commits = lines(unpushed.output)
        if !commits.isEmpty {
            return .refused(
                reason: "\(path) has \(commits.count) commit\(commits.count == 1 ? " that is" : "s that are") on no remote")
        }

        let ignored = run(
            [
                "-C", path, "status", "--porcelain", "-z", "--ignored", "--ignore-submodules=none",
            ], path)
        guard ignored.code == 0 else {
            return .refused(reason: "could not tell what \(path) is ignoring")
        }
        for entry in fields(ignored.output) where entry.hasPrefix("!! ") {
            let relative = String(entry.dropFirst(3))
            guard relative.hasSuffix("/") else { continue }
            let nested = (path as NSString).appendingPathComponent(relative)
            guard exists(nested) else { continue }

            let top = run(["-C", nested, "rev-parse", "--show-toplevel"], nested)
            guard top.code == 0 else { continue }
            let nestedRoot = top.output.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !sameDirectory(nestedRoot, root) else { continue }

            let nestedDirty = run(
                ["-C", nested, "status", "--porcelain", "--ignore-submodules=none"], nested)
            let nestedUnpushed = run(
                [
                    "-C", nested, "log", "--exclude=refs/prefetch/*", "--exclude=refs/notes/*",
                    "--all", "--not", "--remotes", "--oneline",
                ], nested)
            let unexaminable = nestedDirty.code != 0 || nestedUnpushed.code != 0
            if unexaminable || !lines(nestedDirty.output).isEmpty || !lines(nestedUnpushed.output).isEmpty {
                return .refused(
                    reason: "\(nestedRoot) is a separate repository inside \(path), and it "
                        + (unexaminable
                            ? "could not be examined"
                            : "holds work that exists nowhere else"))
            }
        }

        let worktrees = run(["-C", path, "worktree", "list", "--porcelain", "-z"], path)
        guard worktrees.code == 0 else {
            return .refused(reason: "could not list the worktrees of \(path)")
        }

        for entry in worktreeEntries(worktrees.output, root: root) {
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

    private func fields(_ output: String) -> [String] {
        output.split(separator: "\0").map(String.init)
    }

    private func linkedWorktrees(_ output: String, root: String) -> [String] {
        worktreeEntries(output, root: root).map(\.path)
    }

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
