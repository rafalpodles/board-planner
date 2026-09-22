import CryptoKit
import Foundation

// Work settings describe a project, not this machine, so there is no single model or diff limit to
// show. Reporting one would put a number on screen that no run is using.
public struct ProjectConfig: Decodable, Sendable {
    public let project: String
    // What an operator recognises the project by. Optional so a worker older than BP-377 still
    // decodes, the same reason blocked below is optional (BP-512).
    public let key: String?
    public let name: String?
    // autoMerge stood here and the worker has not sent it since the flag was retired — an agent
    // merges because its sequence carries a Merge step. A required field nothing sends made the
    // whole response undecodable, and `try?` at the call site turned that into a config of nil:
    // every value in Preferences read "—", the policy pane was empty, and the reason was invisible.
    public let baseBranch: String
    public let model: String
    public let reviewModel: String
    public let maxDiffLines: Int
    public let taskTimeoutMs: Int
    // Why this project is not being claimed from — the checkout failing the gates' checks, or the
    // board refusing the claim outright — or empty when it is. Optional so a worker older than
    // this field still decodes, for the reason autoMerge's comment above gives (BP-512).
    public let blocked: String?

    /// What an operator recognises it by, the same shape as `ProjectOffer.label` — but with no
    /// repository URL to fall back to, since a bound project already has its checkout.
    public var label: String {
        let name = self.name ?? ""
        let key = self.key ?? ""
        if !name.isEmpty && !key.isEmpty { return "\(name) · \(key)" }
        if !name.isEmpty { return name }
        if !key.isEmpty { return key }
        return project
    }
}

public struct GithubAccountChoice: Decodable, Sendable, Identifiable, Equatable {
    public let login: String
    public let active: Bool
    public var id: String { login }
}

// A project this machine could serve once it has a checkout. What the app offers to set up.
public struct ProjectOffer: Decodable, Sendable, Identifiable, Equatable {
    public let project: String
    public let key: String
    public let name: String
    public let repositoryUrl: String
    public var id: String { project }

    public init(project: String, key: String, name: String, repositoryUrl: String) {
        self.project = project
        self.key = key
        self.name = name
        self.repositoryUrl = repositoryUrl
    }

    /// What an operator recognises it by. A project with neither is still worth listing by its
    /// repository — anything is better than a blank row.
    public var label: String {
        if !name.isEmpty && !key.isEmpty { return "\(name) · \(key)" }
        if !name.isEmpty { return name }
        if !key.isEmpty { return key }
        return repositoryUrl
    }
}

public struct ConfigResponse: Decodable, Sendable {
    public let apiUrl: String
    public let workerName: String
    public let projectCount: Int
    public let pollIntervalMs: Int
    public let projects: [ProjectConfig]
    // Optional so a worker built before BP-373 still decodes: an app that refuses to read the
    // config would show "—" for everything, which reads as a dead worker rather than an old one.
    public let githubAccount: String?
    public let githubAccounts: [GithubAccountChoice]?
    public let offers: [ProjectOffer]?
    public let catalogue: [ProjectCatalogueRow]?
}

public enum SocketError: Error, Equatable {
    case malformedResponse
    case pathTooLong
    case io(Int32)
    // The relocated socket's directory is not this user's own private one, so whatever answers in
    // it may not be this user's worker (BP-778)
    case unsafeDirectory(String)
}

public func sseEvents(from buffer: inout Data) -> [Data] {
    let separator = Data("\n\n".utf8)
    var events: [Data] = []
    while let range = buffer.range(of: separator) {
        let block = buffer[..<range.lowerBound]
        buffer.removeSubrange(..<range.upperBound)
        guard let text = String(data: block, encoding: .utf8) else { continue }
        for line in text.split(separator: "\n") where line.hasPrefix("data: ") {
            events.append(Data(line.dropFirst(6).utf8))
        }
    }
    return events
}

public struct SocketClient: Sendable {
    private let socketPath: String
    private let transport: any Transport

    public init(socketPath: String, transport: any Transport) {
        self.socketPath = socketPath
        self.transport = transport
    }

    // sun_path is 104 bytes, the terminating NUL included
    static let maxSocketPathBytes = 103

    // The worker's own rule (localSocketPath in worker/src/config.ts): beside the state, unless that
    // is too long for a socket, when it moves to /tmp under this user's uid and a digest of the
    // state directory (BP-778).
    public static func socketPath(in stateDirectory: String, uid: uid_t = getuid()) -> String {
        let directory = StateDirectory.normalise(stateDirectory)
        let beside = directory == "/" ? "/worker.sock" : directory + "/worker.sock"
        if beside.utf8.count <= maxSocketPathBytes { return beside }
        let digest = SHA256.hash(data: Data(directory.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
            .prefix(16)
        return "/tmp/cp-worker-\(uid)-\(digest)/worker.sock"
    }

    public static func defaultSocketPath() -> String {
        socketPath(in: StateDirectory.resolve())
    }

    static let relocatedPrefix = "/tmp/cp-worker-"

    // Only the relocated socket is checked: /tmp is shared, so its directory could have been made by
    // anyone before the worker ran. The state directory is the operator's own choice.
    public static func unsafeDirectoryReason(forSocketAt path: String, uid: uid_t = getuid()) -> String? {
        guard path.hasPrefix(relocatedPrefix) else { return nil }
        return directoryRefusal((path as NSString).deletingLastPathComponent, uid: uid)
    }

    public static func directoryRefusal(_ directory: String, uid: uid_t = getuid()) -> String? {
        var info = stat()
        guard lstat(directory, &info) == 0 else {
            return errno == ENOENT ? nil : "\(directory) cannot be inspected (errno \(errno))"
        }
        if (info.st_mode & S_IFMT) == S_IFLNK {
            return "\(directory) is a symbolic link, so the worker's socket may not be there"
        }
        if (info.st_mode & S_IFMT) != S_IFDIR {
            return "\(directory) is not a directory"
        }
        if info.st_uid != uid {
            return "\(directory) belongs to another user (uid \(info.st_uid)); remove it and restart the worker"
        }
        if info.st_mode & 0o077 != 0 {
            return "\(directory) can be opened by other users (mode \(String(info.st_mode & 0o777, radix: 8))); remove it and restart the worker"
        }
        return nil
    }

    private func refuseUnsafeDirectory() throws {
        if let reason = SocketClient.unsafeDirectoryReason(forSocketAt: socketPath) {
            throw SocketError.unsafeDirectory(reason)
        }
    }

    private func request(_ method: String, _ path: String) -> String {
        "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    }

    private func collect(_ method: String, _ path: String) async throws -> HTTPResponse {
        try refuseUnsafeDirectory()
        var bytes = Data()
        for try await chunk in try await transport.send(request(method, path), to: socketPath) {
            bytes.append(chunk)
        }
        guard let head = parseHead(bytes) else { throw SocketError.malformedResponse }

        var body = bytes.dropFirst(head.headerLength)
        if head.chunked {
            var framed = Data(body)
            body = dechunk(from: &framed).data[...]
        }
        return HTTPResponse(status: head.status, body: Data(body))
    }

    public func status() async throws -> StatusResponse {
        try JSONDecoder().decode(StatusResponse.self, from: await collect("GET", "/status").body)
    }

    public func config() async throws -> ConfigResponse {
        try JSONDecoder().decode(ConfigResponse.self, from: await collect("GET", "/config").body)
    }

    @discardableResult
    public func command(_ name: String) async throws -> Bool {
        struct Ack: Decodable { let paused: Bool }
        let response = try await collect("POST", "/\(name)")
        return try JSONDecoder().decode(Ack.self, from: response.body).paused
    }

    public func stream() -> AsyncStream<TelemetryEvent> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    var buffer = Data()
                    var events = Data()
                    var headerSeen = false
                    var chunked = false
                    let decoder = JSONDecoder()
                    try refuseUnsafeDirectory()
                    for try await chunk in try await transport.send(request("GET", "/stream"), to: socketPath) {
                        buffer.append(chunk)
                        if !headerSeen {
                            guard let head = parseHead(buffer) else { continue }
                            buffer.removeSubrange(
                                ..<buffer.index(buffer.startIndex, offsetBy: head.headerLength))
                            headerSeen = true
                            chunked = head.chunked
                        }
                        if chunked {
                            events.append(dechunk(from: &buffer).data)
                        } else {
                            events.append(buffer)
                            buffer.removeAll()
                        }
                        for payload in sseEvents(from: &events) {
                            // One unparseable frame must not end a stream the panel depends on
                            if let event = try? decoder.decode(TelemetryEvent.self, from: payload) {
                                continuation.yield(event)
                            }
                        }
                    }
                } catch {}
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
