import Foundation

// An app launched from Finder or a login item inherits no environment, so CP_STATE_DIR — which is
// the worker's own way of being told where to live — is invisible to it. The operator's setting has
// to survive a normal launch, so it is stored in defaults and consulted first.
public enum StateDirectory {
    public static let defaultsKey = "stateDirectory"

    public static func resolve(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: String = FileManager.default.homeDirectoryForCurrentUser.path
    ) -> String {
        if let stored = nonEmpty(defaults.string(forKey: defaultsKey)) { return stored }
        if let fromEnvironment = nonEmpty(environment["CP_STATE_DIR"]) { return fromEnvironment }
        return (home as NSString).appendingPathComponent(".claudeplanner")
    }

    public static func set(_ path: String?, defaults: UserDefaults = .standard) {
        guard let path = nonEmpty(path) else {
            defaults.removeObject(forKey: defaultsKey)
            return
        }
        defaults.set(path, forKey: defaultsKey)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespaces), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
