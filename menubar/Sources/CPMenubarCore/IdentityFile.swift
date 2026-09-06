import Foundation

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
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
}
