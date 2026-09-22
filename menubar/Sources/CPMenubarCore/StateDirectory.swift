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
        return (home as NSString).appendingPathComponent(".boardplanner")
    }

    public static func set(_ path: String?, defaults: UserDefaults = .standard) {
        guard let path = nonEmpty(path) else {
            defaults.removeObject(forKey: defaultsKey)
            return
        }
        defaults.set(path, forKey: defaultsKey)
    }

    // The worker's normaliseStateDir (worker/src/config.ts): the socket path is derived from this
    // spelling on both sides, so "." and ".." and a trailing slash must not change it.
    public static func normalise(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let absolute = trimmed.hasPrefix("/")
        var parts: [Substring] = []
        for part in trimmed.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." {
                if let last = parts.last, last != ".." { parts.removeLast() }
                else if !absolute { parts.append(part) }
                continue
            }
            parts.append(part)
        }
        let joined = parts.joined(separator: "/")
        if absolute { return "/" + joined }
        return joined.isEmpty ? "." : joined
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
