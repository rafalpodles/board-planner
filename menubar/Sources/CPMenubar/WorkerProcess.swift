import Foundation
import ServiceManagement
import CPMenubarCore

struct PreflightReport: Decodable, Sendable {
    struct Check: Decodable, Sendable, Identifiable {
        let name: String
        let ok: Bool
        let detail: String
        var id: String { name }
    }

    struct GithubAccount: Decodable, Sendable, Identifiable, Equatable {
        let login: String
        let active: Bool
        var id: String { login }
    }

    let ok: Bool
    let account: String
    let checks: [Check]
    let paths: [String: String]
    let path: String
    let githubAccounts: [GithubAccount]?
    let githubAccount: String?
    let githubPinned: Bool?
}

enum WorkerProcessError: LocalizedError {
    case noNode
    case noWorkerBuild(String)
    case preflightUnreadable(String)

    var errorDescription: String? {
        switch self {
        case .noNode:
            return "Could not find node on this machine. Install Node, then try again."
        case .noWorkerBuild(let path):
            return """
                This build of the app carries no worker, and there is none in \(path) either. \
                Rebuild it with menubar/bundle.sh, which is what puts the worker inside the app.
                """
        case .preflightUnreadable(let output):
            return "Could not read the preflight result: \(output)"
        }
    }
}

enum WorkerProcess {
    static func resolveNode() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/sh"
        if let found = runCapturing(shell, ["-lc", "command -v node"])?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n").last.map(String.init),
            found.hasPrefix("/") {
            return found
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for candidate in [
            "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
            "\(home)/.local/bin/node",
        ] where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return nil
    }

    static func preflight(checkout: String) throws -> PreflightReport {
        guard let node = resolveNode() else { throw WorkerProcessError.noNode }
        guard let entry = workerEntry(checkout: checkout) else {
            throw WorkerProcessError.noWorkerBuild(checkout)
        }

        let output = runCapturing(node, [entry, "--preflight"]) ?? ""
        guard let data = output.data(using: .utf8),
            let report = try? JSONDecoder().decode(PreflightReport.self, from: data)
        else {
            throw WorkerProcessError.preflightUnreadable(String(output.prefix(300)))
        }
        return report
    }

    @discardableResult
    static func spawn(state: OnboardingState, stateDirectory: String) throws -> Process {
        guard let node = resolveNode() else { throw WorkerProcessError.noNode }
        guard let entry = workerEntry(checkout: state.checkoutPath) else {
            throw WorkerProcessError.noWorkerBuild(state.checkoutPath)
        }

        let plan = WorkerLauncher.plan(
            nodePath: node, workerEntry: entry, state: state, stateDirectory: stateDirectory)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: plan.executable)
        process.arguments = plan.arguments
        process.environment = plan.environment
        try process.run()
        return process
    }

    static func cloneStep(toolPath: String, githubToken: String = "") -> CloneStep {
        CloneStep(run: { tool, args, cwd in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [tool] + args
            var environment = ProcessInfo.processInfo.environment
            if !toolPath.isEmpty { environment["PATH"] = toolPath }
            if !githubToken.isEmpty {
                environment["GH_TOKEN"] = githubToken
                environment["GITHUB_TOKEN"] = githubToken
            }
            process.environment = GitSafeEnvironment.apply(to: environment)
            if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do { try process.run() } catch { return (1, String(describing: error)) }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        })
    }

    static func git(_ args: [String], cwd: String, toolPath: String) -> (code: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + args
        var environment = ProcessInfo.processInfo.environment
        if !toolPath.isEmpty { environment["PATH"] = toolPath }
        process.environment = GitSafeEnvironment.apply(to: environment)
        if FileManager.default.fileExists(atPath: cwd) {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch { return (1, String(describing: error)) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    static func githubToken(account: String, toolPath: String) -> String {
        let login = account.trimmingCharacters(in: .whitespaces)
        guard !login.isEmpty else { return "" }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["gh", "auth", "token", "--user", login]
        var environment = ProcessInfo.processInfo.environment
        if !toolPath.isEmpty { environment["PATH"] = toolPath }
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return "" }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func workerEntry(checkout: String) -> String? {
        WorkerLauncher.entryPoint(
            bundledAt: WorkerLauncher.bundledEntryPoint(resourcePath: Bundle.main.resourcePath),
            checkout: checkout)
    }

    private static func runCapturing(_ launchPath: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }
}

enum LoginItem {
    static var isRegistered: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static var statusDescription: String {
        switch SMAppService.mainApp.status {
        case .enabled: return "Starts at login"
        case .requiresApproval: return "Turn it on in System Settings › General › Login Items"
        case .notFound: return "Does not start at login"
        default: return "Does not start at login"
        }
    }

    static func register() throws {
        try SMAppService.mainApp.register()
    }

    static func unregister() throws {
        try SMAppService.mainApp.unregister()
    }
}
