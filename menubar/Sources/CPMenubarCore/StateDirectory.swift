import Foundation

public enum StateDirectory {
    public static let defaultsKey = "stateDirectory"

    public static func resolve(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: String = FileManager.default.homeDirectoryForCurrentUser.path
    ) -> String {
        if let stored = nonEmpty(defaults.string(forKey: defaultsKey)) { return stored }
        if let fromEnvironment = nonEmpty(environment["CP_STATE_DIR"]) { return fromEnvironment }
        return (home as NSString).appendingPathComponent(".boardplanner")
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
