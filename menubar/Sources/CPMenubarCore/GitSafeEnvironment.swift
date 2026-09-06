import Foundation

public enum GitSafeEnvironment {
    public static func apply(to environment: [String: String]) -> [String: String] {
        var hardened = environment
        hardened["GIT_CONFIG_NOSYSTEM"] = "1"
        hardened["GIT_PROXY_COMMAND"] = ""
        for redirect in ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
            hardened.removeValue(forKey: redirect)
        }
        return hardened
    }
}
