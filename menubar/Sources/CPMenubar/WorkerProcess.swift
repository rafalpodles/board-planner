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

    let ok: Bool
    let account: String
    let checks: [Check]
    let paths: [String: String]
    /// The repaired PATH, computed by the worker so the repair has one implementation
    let path: String
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
            return "There is no built worker at \(path). Run npm install && npm run build in the worker folder."
        case .preflightUnreadable(let output):
            return "Could not read the preflight result: \(output)"
        }
    }
}

// The one binary the app resolves for itself. Everything else is delegated to the worker's own
// --preflight, so the login-shell subtleties live in one place rather than being rewritten here.
enum WorkerProcess {
    static func resolveNode() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/sh"
        if let found = runCapturing(shell, ["-lc", "command -v node"])?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n").last.map(String.init),
            found.hasPrefix("/") {
            return found
        }
        // A login shell reads .zprofile but not .zshrc, so an nvm node set up there is invisible to
        // it — the same trap CP-236 hit, and the same fallback.
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
        let entry = WorkerLauncher.entryPoint(inCheckout: checkout)
        guard FileManager.default.fileExists(atPath: entry) else {
            throw WorkerProcessError.noWorkerBuild(entry)
        }

        // Exit code 1 means "this machine cannot do the work", which is an answer, not a failure —
        // the report is on stdout either way and is exactly what the screen renders.
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
        let entry = WorkerLauncher.entryPoint(inCheckout: state.checkoutPath)
        guard FileManager.default.fileExists(atPath: entry) else {
            throw WorkerProcessError.noWorkerBuild(entry)
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

// Registering the app itself, not a separate daemon: the app is what holds the worker's lifetime,
// and a login item that starts it starts the worker with it. A bundled plist would be a second
// place for the same configuration to drift.
enum LoginItem {
    static var isRegistered: Bool {
        SMAppService.mainApp.status == .enabled
    }

    // Measured on this machine rather than assumed: `.notFound` is simply "no registration exists"
    // — it does NOT mean the app has to live in /Applications. Registering from a build directory
    // succeeds and reports `.enabled`, which is worth knowing before signing makes it expensive to
    // find out.
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
