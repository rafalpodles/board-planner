import Foundation

// Where registration puts the worker's credential, and therefore where a credential obtained
// through the device flow has to go instead. Same file, same shape, same mode — so a worker that
// was enrolled by the app is indistinguishable from one enrolled by hand, which is what keeps the
// launchd path working rather than quietly rotting.
public struct WorkerIdentity: Codable, Equatable, Sendable {
    public let workerId: String
    public let credential: String
    public let heartbeatMs: Int

    public init(workerId: String, credential: String, heartbeatMs: Int) {
        self.workerId = workerId
        self.credential = credential
        self.heartbeatMs = heartbeatMs
    }
}

public struct IdentityFile: Sendable {
    private let path: String

    public init(path: String) {
        self.path = path
    }

    public static func path(in stateDirectory: String) -> String {
        (stateDirectory as NSString).appendingPathComponent("worker.json")
    }

    public static func defaultPath() -> String {
        path(in: StateDirectory.resolve())
    }

    public func read() throws -> WorkerIdentity? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return try JSONDecoder().decode(WorkerIdentity.self, from: data)
    }

    /// Forgetting the credential this machine holds. A credential is minted by one board and means
    /// nothing to another, so changing boards has to drop it rather than carry it across — and a
    /// file left behind is one a restarted worker would happily present to a server that refuses it.
    public func forget() throws {
        guard FileManager.default.fileExists(atPath: path) else { return }
        try FileManager.default.removeItem(atPath: path)
    }

    public func write(_ identity: WorkerIdentity) throws {
        let data = try JSONEncoder().encode(identity)
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        // .atomic renames a temporary file into place, so the mode has to be set afterwards — a
        // credential is exactly the thing that must not be readable by anyone else.
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
}
