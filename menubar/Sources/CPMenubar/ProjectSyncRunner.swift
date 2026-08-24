import Foundation
import CPMenubarCore

// The half of BP-378 that touches the disk. The choice is made in a browser and arrives here as a
// catalogue on the socket; this turns the difference between it and the machine into clones and
// deletions, one project at a time, saying what happened to each.
//
// Deliberately not silent. A clone takes minutes and a deletion cannot be undone, so every step
// leaves a line the Repositories pane renders — a spinner that ends with a different list is not
// an account of what was done.
@MainActor
@Observable
final class ProjectSyncRunner {
    static let shared = ProjectSyncRunner()

    private(set) var steps: [SyncStep] = []
    private(set) var running = false

    private let file = ReposFile(path: ReposFile.defaultPath())

    /// `busy` is the worker's own answer to "am I running a task", from the socket. Passed in
    /// rather than read here, because a stale copy of it is the difference between a refusal and
    /// deleting a worktree out from under a run.
    func sync(catalogue: [ProjectCatalogueRow], busy: Bool) async {
        guard !running else { return }

        let state = Onboarding.load()
        guard !state.checkoutsFolder.isEmpty else { return }

        let granted = (try? file.read()) ?? []
        let checkouts = await originsOf(granted, toolPath: state.toolPath)
        let plan = ProjectSync.plan(catalogue: catalogue, checkouts: checkouts)
        guard !plan.isEmpty else { return }

        running = true
        defer { running = false }

        let token = WorkerProcess.githubToken(
            account: (try? GithubAccountFile(path: GithubAccountFile.defaultPath()).read()) ?? "",
            toolPath: state.toolPath)
        let setup = ProjectSetup(
            clone: WorkerProcess.cloneStep(toolPath: state.toolPath, githubToken: token),
            repos: file)
        let removal = CheckoutRemoval(run: { args, cwd in
            WorkerProcess.git(args, cwd: cwd, toolPath: state.toolPath)
        })

        for offer in plan.add {
            let parent = state.checkoutsFolder
            let result = await Task.detached { setup.add(offer, parent: parent) }.value
            switch result {
            case .success(let path):
                steps.append(.added(project: offer.label, path: path))
            case .failure(.clone(let reason)), .failure(.grant(let reason)):
                steps.append(.failed(project: offer.label, reason: reason))
            }
        }

        for planned in plan.remove {
            switch removal.check(path: planned.path, workerIsBusy: busy) {
            case .refused(let reason):
                steps.append(.refused(project: planned.project.label, reason: reason))
            case .go(let worktrees):
                do {
                    // The worktrees first: they live beside the checkout, under a root shared with
                    // every other project in that folder, so they are removed by name rather than
                    // by deleting the root they sit in.
                    //
                    // Not `try?`: a worktree that will not delete used to leave no step at all,
                    // and the loop went on to report `.removed` naming the checkout — true, and
                    // read as "all of it went" (BP-418).
                    for worktree in worktrees {
                        try FileManager.default.removeItem(atPath: worktree)
                    }
                    if FileManager.default.fileExists(atPath: planned.path) {
                        try FileManager.default.removeItem(atPath: planned.path)
                    }
                    // The grant goes last. Dropped first, a failed delete would leave a directory
                    // the worker may no longer touch and nothing on screen explaining why.
                    try file.write(((try? file.read()) ?? []).filter { $0 != planned.path })
                    steps.append(.removed(project: planned.project.label, path: planned.path))
                } catch {
                    steps.append(
                        .failed(project: planned.project.label, reason: error.localizedDescription))
                }
            }
        }
    }

    func forget() {
        steps = []
    }

    /// What each allowlisted checkout says its origin is — the only way to tell which project a
    /// directory belongs to, since the socket never carries a path.
    private func originsOf(_ paths: [String], toolPath: String) async -> [String: String] {
        await Task.detached {
            var found: [String: String] = [:]
            for path in paths {
                let result = WorkerProcess.git(["-C", path, "remote", "get-url", "origin"], cwd: path, toolPath: toolPath)
                guard result.code == 0 else { continue }
                let remote = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
                if !remote.isEmpty { found[path] = remote }
            }
            return found
        }.value
    }
}
