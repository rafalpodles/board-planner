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
    public static func plan(
        nodePath: String,
        workerEntry: String,
        state: OnboardingState,
        stateDirectory: String,
        baseEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) -> WorkerLaunchPlan {
        var environment = baseEnvironment
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

    public static func entryPoint(bundledAt bundled: String?, checkout: String) -> String? {
        if let bundled, FileManager.default.fileExists(atPath: bundled) { return bundled }
        let inCheckout = (checkout as NSString).appendingPathComponent("worker/dist/main.js")
        return FileManager.default.fileExists(atPath: inCheckout) ? inCheckout : nil
    }

    public static func bundledEntryPoint(resourcePath: String?) -> String? {
        guard let resourcePath else { return nil }
        return (resourcePath as NSString).appendingPathComponent("worker/main.js")
    }
}
