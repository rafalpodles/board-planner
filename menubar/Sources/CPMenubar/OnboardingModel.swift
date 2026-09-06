import AppKit
import Foundation
import CPMenubarCore

@Observable
@MainActor
final class OnboardingModel {
    private(set) var state: OnboardingState
    private(set) var preflight: PreflightReport?
    private(set) var repositoryProblems: [RepositoryProblem] = []
    private(set) var githubAccount = ""
    private(set) var githubAccounts: [PreflightReport.GithubAccount] = []
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

    func runPreflight(checkout: String) {
        busy = true
        message = ""
        let path = checkout
        Task {
            defer { busy = false }
            do {
                let report = try WorkerProcess.preflight(checkout: path)
                preflight = report
                githubAccounts = report.githubAccounts ?? []
                githubAccount = report.githubAccount ?? ""
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

    func pinGithubAccount(_ login: String) {
        do {
            try GithubAccountFile(path: GithubAccountFile.path(in: stateDirectory)).write(login)
            githubAccount = login.isEmpty
                ? (githubAccounts.first { $0.active }?.login ?? "")
                : login
            runPreflight(checkout: state.checkoutsFolder)
        } catch {
            message = "Could not write the GitHub account: \(error.localizedDescription)"
        }
    }

    var pinnedGithubAccount: String {
        (try? GithubAccountFile(path: GithubAccountFile.path(in: stateDirectory)).read()) ?? ""
    }

    func chooseFolder(_ path: String) {
        repositoryProblems = RepositoryCheck.problems(at: path, RepositoryCheck.inspect(path))
        guard repositoryProblems.isEmpty else { return }

        state = Onboarding.folderChosen(state, path: path)
        persist()
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
                message = "Could not reach \(BoardURL.normalise(apiURL)) — \(error.localizedDescription)"
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
                    state = Onboarding.approvalAbandoned(state)
                    persist()
                    message = "That enrolment ended without a credential. Try connecting again."
                    return
                case .approved(let workerID, let credential, let heartbeatMs, let repositoryURL, let projectKey):
                    adopt(
                        workerID: workerID, credential: credential, heartbeatMs: heartbeatMs,
                        repositoryURL: repositoryURL, projectKey: projectKey)
                    return
                }
            }
        }
    }

    private func adopt(
        workerID: String, credential: String, heartbeatMs: Int,
        repositoryURL: String, projectKey: String
    ) {
        do {
            try IdentityFile(path: IdentityFile.path(in: stateDirectory)).write(
                WorkerIdentity(workerId: workerID, credential: credential, heartbeatMs: heartbeatMs))
        } catch {
            message = "Could not store the credential: \(error.localizedDescription)"
            return
        }
        state = Onboarding.approved(state, workerID: workerID)
        persist()

        message = "Cloning \(repositoryURL)…"
        switch WorkerProcess.cloneStep(
            toolPath: state.toolPath,
            githubToken: WorkerProcess.githubToken(
                account: pinnedGithubAccount, toolPath: state.toolPath)
        ).run(
            repositoryURL: repositoryURL, parent: state.checkoutsFolder, projectKey: projectKey)
        {
        case .cloned(let path), .reused(let path):
            state = Onboarding.cloned(state, at: path)
            persist()
            grantLocally(path)
            startWorker()
        case .failed(let reason):
            message = reason
        }
    }

    private func grantLocally(_ path: String) {
        do {
            let file = ReposFile(path: ReposFile.path(in: stateDirectory))
            var repos = (try? file.read()) ?? []
            if !repos.contains(path) { repos.append(path) }
            try file.write(repos)
        } catch {
            message = "Could not write repos.json: \(error.localizedDescription)"
        }
    }

    func startWorker() {
        do {
            RunningWorker.shared.adopt(try WorkerProcess.spawn(state: state, stateDirectory: stateDirectory))
            state = Onboarding.started(state)
            persist()
            message = ""
        } catch {
            message = error.localizedDescription
        }
    }

    func resumeWorker(listening: () async -> Bool = OnboardingModel.somethingIsListening) async {
        guard
            WorkerResume.shouldStart(
                isOnboarded: state.isOnboarded,
                weAlreadyStartedOne: RunningWorker.shared.isOurs,
                somethingIsListening: await listening())
        else { return }

        startWorker()
    }

    private static func somethingIsListening() async -> Bool {
        let client = SocketClient(
            socketPath: SocketClient.defaultSocketPath(), transport: POSIXTransport())
        return (try? await client.status()) != nil
    }

    func changeBoard() {
        poller?.cancel()
        RunningWorker.shared.stop()

        do {
            try IdentityFile(path: IdentityFile.path(in: stateDirectory)).forget()
        } catch {
            message = "Could not remove the old credential: \(error.localizedDescription)"
            return
        }

        state = Onboarding.changingBoard(state)
        persist()
        apiURL = state.apiURL
        workerName = state.workerName
        preflight = nil
        repositoryProblems = []
        message = "Point this machine at another board, then connect it again."
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
