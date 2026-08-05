import Foundation

public enum ReposError: Error, Equatable {
    case notAbsolute
}

public struct ReposFile: Sendable {
    private let path: String

    public init(path: String) {
        self.path = path
    }

    public static func path(in stateDirectory: String) -> String {
        (stateDirectory as NSString).appendingPathComponent("repos.json")
    }

    public static func defaultPath() -> String {
        path(in: StateDirectory.resolve())
    }

    private struct Document: Codable {
        let repos: [String]
    }

    public func read() throws -> [String] {
        guard FileManager.default.fileExists(atPath: path) else { return [] }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return try JSONDecoder().decode(Document.self, from: data).repos
    }

    public func write(_ paths: [String]) throws {
        guard paths.allSatisfy({ $0.hasPrefix("/") }) else { throw ReposError.notAbsolute }

        let data = try JSONEncoder().encode(Document(repos: paths))
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        // .atomic writes a temporary file and renames, so the mode has to be set after the rename —
        // before it, this would chmod a file that no longer exists.
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
}
