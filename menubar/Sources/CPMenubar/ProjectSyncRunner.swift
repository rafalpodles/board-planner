import Foundation
import CPMenubarCore

@MainActor
@Observable
final class ProjectSyncRunner {
    static let shared = ProjectSyncRunner()

    private(set) var steps: [SyncStep] = []
    private(set) var running = false

    private let file = ReposFile(path: ReposFile.defaultPath())

    func sync(catalogue: [ProjectCatalogueRow], isBusy: @escaping () async -> Bool) async {
        guard !running else { return }
        running = true
        defer { running = false }

        let state = Onboarding.load()
        guard !state.checkoutsFolder.isEmpty else { return }

        let granted = (try? file.read()) ?? []
        let checkouts = await originsOf(granted, toolPath: state.toolPath)
        let plan = ProjectSync.plan(catalogue: catalogue, checkouts: checkouts)
        guard !plan.isEmpty else { return }

        let token = WorkerProcess.githubToken(
            account: (try? GithubAccountFile(path: GithubAccountFile.defaultPath()).read()) ?? "",
            toolPath: state.toolPath)
        let setup = ProjectSetup(
            clone: WorkerProcess.cloneStep(toolPath: state.toolPath, githubToken: token),
            repos: file)
        let removal = CheckoutRemoval(run: { args, cwd in
            WorkerProcess.git(args, cwd: cwd, toolPath: state.toolPath)
        })

        let deletion = CheckoutDeletion(
            remove: { try FileManager.default.removeItem(atPath: $0) },
            exists: { FileManager.default.fileExists(atPath: $0) },
            forget: { [file] path in
                try file.write(((try? file.read()) ?? []).filter { $0 != path })
            }
        )

        let parent = state.checkoutsFolder
        await SyncPass.run(
            plan: plan,
            add: { offer in await Task.detached { setup.add(offer, parent: parent) }.value },
            isBusy: isBusy,
            deletion: deletion,
            removal: removal,
            onStep: { step in self.steps.append(step) })
    }

    func forget() {
        steps = []
    }

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
