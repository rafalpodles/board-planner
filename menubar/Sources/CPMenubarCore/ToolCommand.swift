import Foundation

public enum ResolvedTool: String, Sendable {
    case git
    case gh
}

public struct UnresolvedTool: LocalizedError, Equatable, Sendable {
    public let tool: ResolvedTool

    public var errorDescription: String? {
        "No absolute \(tool.rawValue) path was resolved — run the setup check again. Refusing to run \(tool.rawValue) by name on PATH."
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
        _ tool: ResolvedTool, _ arguments: [String], resolved: [String: String]
    ) -> Result<ToolCommand, UnresolvedTool> {
        guard let path = resolved[tool.rawValue], path.hasPrefix("/") else {
            return .failure(UnresolvedTool(tool: tool))
        }
        return .success(ToolCommand(executable: path, arguments: arguments))
    }
}
