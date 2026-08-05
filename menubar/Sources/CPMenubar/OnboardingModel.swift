import AppKit
import Foundation
import CPMenubarCore

// One object per step of the state machine, so re-entering a step is calling its function again
// rather than replaying a sequence of side effects that half happened. Everything it decides is
// persisted before the side effect, never after.
@Observable
@MainActor
final class OnboardingModel {
    private(set) var state: OnboardingState
    private(set) var preflight: PreflightReport?
    private(set) var repositoryProblems: [RepositoryProblem] = []
    private(set) var busy = false
    var message = ""

    var apiURL: String
    var workerName: String

    private var poller: Task<Void, Never>?

    init() {
        let loaded = Onboarding.load()
        state = loaded
        apiURL = loaded.apiURL
        workerName = loaded.workerName.isEmpty ? Host.current().localizedName ?? "this Mac" : loaded.workerName
    }

    var stateDirectory: String { StateDirectory.resolve() }

    private func persist() { Onboarding.save(state) }

    // Nothing else is offered until this passes: a machine that cannot do the work should never
    // reach the fleet console looking healthy.
    func runPreflight(checkout: String) {
        busy = true
        message = ""
        let path = checkout
        Task {
            defer { busy = false }
            do {
                let report = try WorkerProcess.preflight(checkout: path)
                preflight = report
                if report.ok {
                    state = Onboarding.preflightPassed(
                        state, apiURL: apiURL, workerName: workerName, toolPath: report.path)
                    persist()
                }
            } catch {
                message = error.localizedDescription
            }
        }
    }

    // Refused here rather than after enrolment, where the same pick surfaces as a string in the
    // fleet console once it is already too late to be useful
    func chooseFolder(_ path: String) {
        repositoryProblems = RepositoryCheck.problems(at: path, RepositoryCheck.inspect(path))
        guard repositoryProblems.isEmpty else { return }

        state = Onboarding.folderChosen(state, path: path)
        persist()

        // repos.json is what grants this directory locally, and it is still the only thing that can
        do {
            let file = ReposFile(path: ReposFile.path(in: stateDirectory))
            var repos = (try? file.read()) ?? []
            if !repos.contains(path) { repos.append(path) }
            try file.write(repos)
        } catch {
            message = "Could not write repos.json: \(error.localizedDescription)"
        }
    }

    func connect() {
        guard !busy else { return }
        busy = true
        message = ""
        let client = DeviceEnrolmentClient(apiURL: apiURL)
        let machine = workerName
        let host = Host.current().name ?? ""

        Task {
            do {
                let started = try await client.begin(machineName: machine, machineHost: host)
                state = Onboarding.approvalStarted(
                    state,
                    deviceCode: started.deviceCode,
                    userCode: started.userCode,
                    verificationURL: started.verificationUrl)
                persist()
                if let url = URL(string: started.verificationUrl) { NSWorkspace.shared.open(url) }
                pollUntilDecided(client: client, intervalMs: started.intervalMs)
            } catch {
                busy = false
                message = "Could not start enrolment: \(error.localizedDescription)"
            }
        }
    }

    private func pollUntilDecided(client: DeviceEnrolmentClient, intervalMs: Int) {
        poller?.cancel()
        poller = Task {
            defer { busy = false }
            while !Task.isCancelled, !state.deviceCode.isEmpty {
                try? await Task.sleep(for: .milliseconds(intervalMs))
                guard let result = try? await client.poll(deviceCode: state.deviceCode) else { continue }

                switch result {
                case .pending:
                    continue
                case .finished:
                    // Refused, expired, or already collected — the folder stays chosen, so trying
                    // again costs one click rather than the whole flow
                    state = Onboarding.approvalAbandoned(state)
                    persist()
                    message = "That enrolment ended without a credential. Try connecting again."
                    return
                case .approved(let workerID, let credential, let heartbeatMs):
                    adopt(workerID: workerID, credential: credential, heartbeatMs: heartbeatMs)
                    return
                }
            }
        }
    }

    // The credential goes where registration would have put it, so a worker enrolled by the app is
    // indistinguishable from one enrolled by hand — which is what keeps the launchd path alive.
    private func adopt(workerID: String, credential: String, heartbeatMs: Int) {
        do {
            try IdentityFile(path: IdentityFile.path(in: stateDirectory)).write(
                WorkerIdentity(workerId: workerID, credential: credential, heartbeatMs: heartbeatMs))
        } catch {
            message = "Could not store the credential: \(error.localizedDescription)"
            return
        }
        state = Onboarding.approved(state, workerID: workerID)
        persist()
        startWorker()
    }

    func startWorker() {
        do {
            try WorkerProcess.spawn(state: state, stateDirectory: stateDirectory)
            state = Onboarding.started(state)
            persist()
            message = ""
        } catch {
            message = error.localizedDescription
        }
    }

    func registerLoginItem() {
        do {
            try LoginItem.register()
            message = LoginItem.statusDescription
        } catch {
            message = "Could not register as a login item: \(error.localizedDescription)"
        }
    }

    func startAgain() {
        poller?.cancel()
        Onboarding.reset()
        state = OnboardingState()
        preflight = nil
        repositoryProblems = []
        message = ""
    }
}
