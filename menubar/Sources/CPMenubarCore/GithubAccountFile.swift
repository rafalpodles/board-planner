import Foundation

// Which GitHub account this machine's worker pushes as. `gh auth switch` is global machine state
// that any terminal on the box can flip mid-run, so the operator's choice lives here and the worker
// resolves that login's token by name. The login is not a secret; the token is never written down.
public struct GithubAccountFile: Sendable {
    private let path: String

    public init(path: String) {
        self.path = path
    }

    public static func path(in stateDirectory: String) -> String {
        (stateDirectory as NSString).appendingPathComponent("github.json")
    }

    public static func defaultPath() -> String {
        path(in: StateDirectory.resolve())
    }

    private struct Document: Codable {
        let account: String
    }

    /// Empty for "nothing pinned" — which is also what an absent or unreadable file means, because
    /// the worker's behaviour without a pin is exactly what it always was.
    public func read() throws -> String {
        guard FileManager.default.fileExists(atPath: path) else { return "" }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let document = try? JSONDecoder().decode(Document.self, from: data) else { return "" }
        return document.account
    }

    // A name and address the operator set by hand (BP-779) belong to the account they were set for,
    // so they survive re-picking that account and go when another one is picked.
    public func write(_ account: String) throws {
        let login = account.trimmingCharacters(in: .whitespaces)
        var document: [String: String] = ["account": login]
        if let existing = try? Data(contentsOf: URL(fileURLWithPath: path)),
           let previous = try? JSONSerialization.jsonObject(with: existing) as? [String: Any],
           previous["account"] as? String == login {
            for key in ["name", "email"] {
                if let value = previous[key] as? String { document[key] = value }
            }
        }
        let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        // .atomic renames a temporary file into place, so the mode has to be set after the rename
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
}
