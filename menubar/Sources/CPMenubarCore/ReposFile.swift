import Foundation

public enum ReposError: Error, Equatable {
    case notAbsolute
}

public struct ReposFile: Sendable {
    private let locate: @Sendable () -> String

    /// A file at a path the caller already knows — a test, or a directory it chose itself.
    public init(path: String) {
        self.locate = { path }
    }

    /// The allowlist wherever the state directory is **now**, resolved on every use.
    ///
    /// BP-600. This used to be spelled `ReposFile(path: .defaultPath())` at every call site, which
    /// froze whichever directory was current when its holder was built. `ProjectSyncRunner` is a
    /// singleton, and the screen that offers the state-directory chooser is the screen that
    /// initialises it — so after a switch the app granted and dropped checkouts in a file the
    /// worker on the new directory never reads, and reported on screen that both had worked.
    /// Making the file follow puts that right for every holder at once, including ones not written
    /// yet; a `let` holding one of these is now safe.
    /// Takes the **state directory**, not the file path, because the directory is the thing that
    /// moves — and because a closure labelled with the file invites being handed a directory. I
    /// wrote that mistake into this type's own test on the first attempt.
    public init(
        inStateDirectory resolve: @escaping @Sendable () -> String = { StateDirectory.resolve() }
    ) {
        self.locate = { ReposFile.path(in: resolve()) }
    }

    private var path: String { locate() }

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
