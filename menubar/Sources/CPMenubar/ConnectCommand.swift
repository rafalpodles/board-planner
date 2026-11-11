import AppKit
import Foundation
import CPMenubarCore

// The first-run window as one command a coding agent can run and read. The approval stays a person's click.
enum ConnectCommand {
    struct Options: Equatable {
        var boardURL: String
        var folder: String
    }

    enum Parsed: Equatable {
        case notRequested
        case run(Options)
        case usage
    }

    static let usage =
        "usage: CPMenubar --connect <board address> [--folder <the folder this Mac keeps its checkouts in>]"

    static func parse(_ arguments: [String], home: String, workingDirectory: String) -> Parsed {
        guard arguments.count > 1, arguments[1] == "--connect" else { return .notRequested }
        var rest = Array(arguments.dropFirst(2))
        guard let board = rest.first, !board.hasPrefix("--") else { return .usage }
        rest.removeFirst()

        var folder = (home as NSString).appendingPathComponent("board-planner")
        while let flag = rest.first {
            rest.removeFirst()
            guard flag == "--folder", let value = rest.first, !value.hasPrefix("--") else { return .usage }
            rest.removeFirst()
            let expanded = (value as NSString).expandingTildeInPath
            folder = URL(fileURLWithPath: expanded, relativeTo: URL(fileURLWithPath: workingDirectory, isDirectory: true))
                .standardizedFileURL.path
        }
        return .run(Options(boardURL: board, folder: folder))
    }

    struct Deps: Sendable {
        var say: @Sendable (String) -> Void
        var load: @Sendable () -> OnboardingState
        var save: @Sendable (OnboardingState) -> Void
        var insideTheApp: Bool
        var otherInstanceRunning: @Sendable () -> Bool
        var closeOtherInstance: @Sendable () -> Void
        var makeFolder: @Sendable (String) throws -> Void
        var resolve: @Sendable (String) -> String
        var inspect: @Sendable (String) -> RepositoryInspection
        var preflight: @Sendable (String) throws -> PreflightReport
        var machineName: String
        var host: String
        var begin: @Sendable (_ board: String, _ machineName: String, _ host: String) async throws -> DeviceEnrolmentStart
        var poll: @Sendable (_ board: String, _ deviceCode: String) async throws -> DeviceEnrolmentPoll
        var sleep: @Sendable (_ milliseconds: Int) async -> Void
        var openBrowser: @Sendable (String) -> Void
        var writeIdentity: @Sendable (WorkerIdentity) throws -> Void
        var clone: @Sendable (_ state: OnboardingState, _ repositoryURL: String, _ projectKey: String) -> CloneOutcome
        var grant: @Sendable (String) throws -> Void
        var openApp: @Sendable () -> Void
    }

    static let unreachablePollLimit = 30

    static func run(_ options: Options, _ deps: Deps) async -> Int32 {
        let say = deps.say
        let board = BoardURL.normalise(options.boardURL)
        var state = deps.load()

        if state.isOnboarded {
            if BoardURL.normalise(state.apiURL) == board {
                say("This Mac is already connected to \(board) as \(state.workerName). Nothing to do.")
                deps.openApp()
                return 0
            }
            say("✗ This Mac is connected to \(state.apiURL), not \(board).")
            say("To move it, choose Change board in the Board Planner Worker menu, then run this again.")
            return 1
        }

        if deps.otherInstanceRunning() {
            guard deps.insideTheApp else {
                say("✗ Board Planner Worker is open, and this copy of the command does not share its settings.")
                say("Run the command from inside the installed app: \"/Applications/Board Planner Worker.app/Contents/MacOS/CPMenubar\" --connect …")
                return 1
            }
            say("Closing the Board Planner Worker setup window: setup continues here.")
            deps.closeOtherInstance()
        }

        do {
            try deps.makeFolder(options.folder)
        } catch {
            say("✗ Could not create \(options.folder): \(error.localizedDescription)")
            return 1
        }
        let folder = deps.resolve(options.folder)
        let problems = RepositoryCheck.problems(at: folder, deps.inspect(folder))
        if !problems.isEmpty {
            for problem in problems { say("✗ \(problem.summary) \(problem.fix)") }
            say("Pass another folder with --folder.")
            return 1
        }

        say("Checking this Mac…")
        let report: PreflightReport
        do {
            report = try deps.preflight(folder)
        } catch {
            say("✗ \(error.localizedDescription)")
            return 1
        }
        for check in report.checks { say("  \(check.ok ? "✓" : "✗") \(check.name): \(check.detail)") }
        guard report.ok else {
            say("This Mac cannot run tasks yet. Fix the ✗ rows above, then run this command again.")
            return 1
        }

        let name = state.workerName.isEmpty ? deps.machineName : state.workerName
        state = Onboarding.preflightPassed(
            state, apiURL: board, workerName: name, toolPath: report.path, toolPaths: report.paths)
        state = Onboarding.folderChosen(state, path: folder)
        deps.save(state)

        let started: DeviceEnrolmentStart
        do {
            started = try await deps.begin(board, name, deps.host)
        } catch {
            say("✗ Could not reach \(board): \(error.localizedDescription)")
            return 1
        }
        state = Onboarding.approvalStarted(
            state, deviceCode: started.deviceCode, userCode: started.userCode,
            verificationURL: started.verificationUrl)
        deps.save(state)

        say("Approve this Mac in your browser: \(started.verificationUrl)")
        say("It shows the code \(started.userCode). Choose the board it should work on, then Approve.")
        deps.openBrowser(started.verificationUrl)

        var unreachable = 0
        while true {
            await deps.sleep(started.intervalMs)
            let result: DeviceEnrolmentPoll
            do {
                result = try await deps.poll(board, started.deviceCode)
                unreachable = 0
            } catch {
                unreachable += 1
                if unreachable >= unreachablePollLimit {
                    say("✗ Lost the connection to \(board) while waiting: \(error.localizedDescription)")
                    say("Run this command again once it is reachable.")
                    return 1
                }
                continue
            }

            switch result {
            case .pending:
                continue
            case .finished:
                state = Onboarding.approvalAbandoned(state)
                deps.save(state)
                say("✗ The approval was refused or expired. Run this command again for a new code.")
                return 1
            case .approved(let workerID, let credential, let heartbeatMs, let repositoryURL, let projectKey):
                return finish(
                    state: state, deps: deps, workerID: workerID,
                    identity: WorkerIdentity(workerId: workerID, credential: credential, heartbeatMs: heartbeatMs),
                    repositoryURL: repositoryURL, projectKey: projectKey)
            }
        }
    }

    private static func finish(
        state approvedState: OnboardingState, deps: Deps, workerID: String, identity: WorkerIdentity,
        repositoryURL: String, projectKey: String
    ) -> Int32 {
        let say = deps.say
        var state = approvedState
        do {
            try deps.writeIdentity(identity)
        } catch {
            say("✗ Could not store this Mac's credential: \(error.localizedDescription)")
            return 1
        }
        state = Onboarding.approved(state, workerID: workerID)
        deps.save(state)

        say("Approved. Cloning \(repositoryURL) into \(state.checkoutsFolder)…")
        switch deps.clone(state, repositoryURL, projectKey) {
        case .failed(let reason):
            say("✗ \(reason)")
            say("Fix that, then run this command again. You will approve this Mac once more.")
            return 1
        case .cloned(let path), .reused(let path):
            state = Onboarding.cloned(state, at: path)
            deps.save(state)
            do {
                try deps.grant(path)
            } catch {
                say("✗ Could not write repos.json: \(error.localizedDescription)")
                return 1
            }
            state = Onboarding.started(state)
            deps.save(state)
            deps.openApp()
            say("✓ Connected. \(state.workerName) works on \(projectKey) tasks handed to you, in its own clone at \(path).")
            say("Board Planner Worker is running in the menu bar.")
            return 0
        }
    }
}

extension ConnectCommand {
    static let bundleIdentifier = "com.boardplanner.menubar"

    static func runIfRequested() {
        let options: Options
        switch parse(
            ProcessInfo.processInfo.arguments,
            home: FileManager.default.homeDirectoryForCurrentUser.path,
            workingDirectory: FileManager.default.currentDirectoryPath)
        {
        case .notRequested:
            return
        case .usage:
            print(usage)
            exit(2)
        case .run(let parsed):
            options = parsed
        }

        final class Outcome: @unchecked Sendable { var code: Int32 = 1 }
        let outcome = Outcome()
        let done = DispatchSemaphore(value: 0)
        let deps = live()
        Task.detached {
            outcome.code = await run(options, deps)
            done.signal()
        }
        done.wait()
        exit(outcome.code)
    }

    static func live() -> Deps {
        let stateDirectory = StateDirectory.resolve()
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let ownIdentifier = Bundle.main.bundleIdentifier
        let insideTheApp = ownIdentifier != nil
        let others: @Sendable () -> [NSRunningApplication] = {
            NSRunningApplication.runningApplications(withBundleIdentifier: ownIdentifier ?? bundleIdentifier)
                .filter { $0.processIdentifier != ownPID }
        }
        return Deps(
            say: { line in
                print(line)
                fflush(stdout)
            },
            load: { Onboarding.load() },
            save: { Onboarding.save($0) },
            insideTheApp: insideTheApp,
            otherInstanceRunning: { !others().isEmpty },
            closeOtherInstance: {
                let running = others()
                running.forEach { $0.terminate() }
                let deadline = Date().addingTimeInterval(5)
                while running.contains(where: { !$0.isTerminated }), Date() < deadline {
                    Thread.sleep(forTimeInterval: 0.1)
                }
            },
            makeFolder: { path in
                try FileManager.default.createDirectory(
                    atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
            },
            resolve: { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path },
            inspect: { RepositoryCheck.inspect($0) },
            preflight: { try WorkerProcess.preflight(checkout: $0) },
            machineName: Host.current().localizedName ?? "this Mac",
            host: Host.current().name ?? "",
            begin: { board, name, host in
                try await DeviceEnrolmentClient(apiURL: board).begin(machineName: name, machineHost: host)
            },
            poll: { board, code in try await DeviceEnrolmentClient(apiURL: board).poll(deviceCode: code) },
            sleep: { try? await Task.sleep(for: .milliseconds($0)) },
            openBrowser: { link in
                if let url = URL(string: link) { NSWorkspace.shared.open(url) }
            },
            writeIdentity: { try IdentityFile(path: IdentityFile.path(in: stateDirectory)).write($0) },
            clone: { state, repositoryURL, projectKey in
                let account = (try? GithubAccountFile(path: GithubAccountFile.path(in: stateDirectory)).read()) ?? ""
                return WorkerProcess.cloneStep(
                    tools: state, githubToken: WorkerProcess.githubToken(account: account, tools: state)
                ).run(repositoryURL: repositoryURL, parent: state.checkoutsFolder, projectKey: projectKey)
            },
            grant: { path in
                let file = ReposFile(path: ReposFile.path(in: stateDirectory))
                var repos = (try? file.read()) ?? []
                if !repos.contains(path) { repos.append(path) }
                try file.write(repos)
            },
            openApp: {
                guard insideTheApp else { return }
                let open = Process()
                open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                open.arguments = [Bundle.main.bundlePath]
                try? open.run()
                open.waitUntilExit()
            }
        )
    }
}
