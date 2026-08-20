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
    /// The repaired PATH, computed by the worker so the repair has one implementation
    let path: String
    // Decoded leniently on purpose: a bundled worker older than this app reports no accounts, and
    // an app that refuses to read its report is worse than one that offers no picker.
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
            // "Reinstall" was the advice here once, and it never helped: an app assembled without
            // the worker has none to reinstall, and the same build produces the same bundle again.
            return """
                This build of the app carries no worker, and there is none in \(path) either. \
                Rebuild it with menubar/bundle.sh, which is what puts the worker inside the app.
                """
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
        guard let entry = workerEntry(checkout: checkout) else {
            throw WorkerProcessError.noWorkerBuild(checkout)
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
        // The app now owns this one's lifetime — see RunningWorker
        return process
    }

    // git runs on the PATH preflight resolved, not the one Finder handed this app — the same trap
    // the worker itself hits, one level up.
    //
    // githubToken pins the identity the clone and its push probe act as. Without it the probe would
    // prove that *whichever account gh has active* can push, while the worker pushes as the pinned
    // one — the check and the thing it checks would be two different machines' worth of access.
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
            process.environment = environment
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

    // Asked of gh by name rather than taken from whatever is active, which is the whole point of
    // the pin. Empty when nothing is pinned, or when gh has no session for it — the caller carries
    // on either way, because gh resolving its own identity is what always used to happen.
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
