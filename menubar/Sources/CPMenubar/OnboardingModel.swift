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
    /// The account the worker will push and open pull requests as, and the accounts it could use
    /// instead. Empty until preflight has run, which is also when gh is first asked.
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

    // `gh auth switch` is global machine state — any terminal on this box can flip it mid-run — so
    // the choice is written down and the worker resolves that login's token by name. Re-running
    // preflight is not a formality here: it is what turns "pinned to an account gh does not have"
    // into a red row now instead of a 403 half an hour into a run.
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

    // Refused here rather than after enrolment, where the same pick surfaces as a string in the
    // fleet console once it is already too late to be useful
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
                    // Refused, expired, or already collected — the folder stays chosen, so trying
                    // again costs one click rather than the whole flow
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

    // The credential goes where registration would have put it, so a worker enrolled by the app is
    // indistinguishable from one enrolled by hand — which is what keeps the launchd path alive.
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

        // Registration handed back a credential before anything was cloned, so a worker exists on
        // the board that cannot yet do a thing. It is not started until the clone is there and a
        // push has been shown to work — there is never one that looks ready and is not.
        message = "Cloning \(repositoryURL)…"
        // The probe pushes as the account the worker will push as, not as whichever one gh has
        // active — otherwise it proves access this machine will never use.
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
            // The credential is kept: the enrolment succeeded, only the clone did not, and redoing
            // the approval would spend a second one for nothing.
            message = reason
        }
    }

    // repos.json is what grants this directory locally, and it stays the only thing that can
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

    /// Run when the app comes up, so an already-onboarded machine has a worker rather than a panel
    /// retrying a socket forever.
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


    func startAgain() {
        poller?.cancel()
        Onboarding.reset()
        state = OnboardingState()
        preflight = nil
        repositoryProblems = []
        message = ""
    }
}
