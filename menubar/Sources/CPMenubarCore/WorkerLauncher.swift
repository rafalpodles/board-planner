import Foundation

public struct WorkerLaunchPlan: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let environment: [String: String]

    public init(executable: String, arguments: [String], environment: [String: String]) {
        self.executable = executable
        self.arguments = arguments
        self.environment = environment
    }
}

public enum WorkerLauncher {
    // The trap this whole task is built around. An app launched from Finder — or by a login item —
    // inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin, and anything it spawns inherits that. The worker
    // builds every child environment from an allowlist that copies PATH from its own process, so a
    // worker spawned this way cannot see Homebrew, nvm, or ~/.local/bin however carefully preflight
    // found them: green check, every task failing. The PATH preflight resolved has to be handed
    // over explicitly, and it is the only reason toolPath is persisted.
    public static func plan(
        nodePath: String,
        workerEntry: String,
        state: OnboardingState,
        stateDirectory: String,
        baseEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) -> WorkerLaunchPlan {
        var environment = baseEnvironment
        // Same variables the launchd plist sets. The app is a convenience over that contract, never
        // a replacement — a worker started by hand has to keep working exactly as it does now.
        environment["CP_API_URL"] = state.apiURL
        environment["CP_WORKER_NAME"] = state.workerName
        environment["CP_STATE_DIR"] = stateDirectory
        if !state.toolPath.isEmpty { environment["PATH"] = state.toolPath }

        return WorkerLaunchPlan(
            executable: nodePath,
            arguments: [workerEntry],
            environment: environment
        )
    }

    // Deliberately not `dist/main.js` guessed from a bundle path: the operator points at a checkout,
    // and this is where the built worker lives inside it.
    public static func entryPoint(inCheckout checkout: String) -> String {
        (checkout as NSString).appendingPathComponent("worker/dist/main.js")
    }
}
