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
        // Normalised here because this value crosses into another program with stricter parsing.
        // "localhost:3973" is what people type and what Swift's own client copes with; Node's fetch
        // rejects it as an unknown scheme, so every request the worker makes fails — it registers,
        // clones, starts, and then never reports, which reads as a dead machine rather than a typo.
        environment["CP_API_URL"] = BoardURL.normalise(state.apiURL)
        environment["CP_WORKER_NAME"] = state.workerName
        environment["CP_STATE_DIR"] = stateDirectory
        if !state.toolPath.isEmpty { environment["PATH"] = state.toolPath }

        return WorkerLaunchPlan(
            executable: nodePath,
            arguments: [workerEntry],
            environment: environment
        )
    }

    // The worker the app ships with, and the reason the app can be handed to somebody else at all.
    // A distributed app cannot read the worker out of the operator's checkout: that checkout is
    // *their* project, and has no worker/ in it. Only a Board Planner checkout does, which is why
    // this looked fine right up until the app left the machine that built it.
    public static func entryPoint(bundledAt bundled: String?, checkout: String) -> String? {
        if let bundled, FileManager.default.fileExists(atPath: bundled) { return bundled }
        // Falls back to the checkout so a developer running from a Board Planner clone still works
        let inCheckout = (checkout as NSString).appendingPathComponent("worker/dist/main.js")
        return FileManager.default.fileExists(atPath: inCheckout) ? inCheckout : nil
    }

    /// Where bundle.sh puts the worker inside the .app
    public static func bundledEntryPoint(resourcePath: String?) -> String? {
        guard let resourcePath else { return nil }
        return (resourcePath as NSString).appendingPathComponent("worker/main.js")
    }
}
