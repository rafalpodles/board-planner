import Foundation

public enum ResolvedTool: String, Sendable {
    case git
    case gh
}

public struct UnresolvedTool: LocalizedError, Equatable, Sendable {
    public let tool: ResolvedTool

    public var errorDescription: String? {
        "No \(tool.rawValue) was found where this app last looked for it. To look again, press Check this machine during setup, or quit and reopen the app once it is set up — it will not run \(tool.rawValue) by name on PATH."
    }
}

public enum ToolPath {
    /// Recorded, absolute, and still there: a path whose tool was uninstalled or moved since the
    /// check that recorded it is as unresolved as one never recorded.
    public static func usable(
        _ path: String?, isExecutable: (String) -> Bool = FileManager.default.isExecutableFile(atPath:)
    ) -> Bool {
        guard let path, path.hasPrefix("/") else { return false }
        return isExecutable(path)
    }
}

/// What the app spawns for git or gh: the absolute path `--preflight` resolved, never the name
/// looked up through `/usr/bin/env` on the PATH the app hands its children — anything earlier on
/// that PATH would silently become git, or become the gh that is handed the pinned account's token
/// (BP-733, the worker's BP-641 one level up). No path, no spawn: refused rather than falling back.
public struct ToolCommand: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]

    public static func make(
        _ tool: ResolvedTool, _ arguments: [String], resolved: [String: String],
        isExecutable: (String) -> Bool = FileManager.default.isExecutableFile(atPath:)
    ) -> Result<ToolCommand, UnresolvedTool> {
        guard let path = resolved[tool.rawValue], ToolPath.usable(path, isExecutable: isExecutable) else {
            return .failure(UnresolvedTool(tool: tool))
        }
        return .success(ToolCommand(executable: path, arguments: arguments))
    }
}
