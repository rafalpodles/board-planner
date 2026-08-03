import Foundation

public struct ConfigResponse: Decodable, Sendable {
    public let apiUrl: String
    public let workerName: String
    public let projectCount: Int
    public let model: String
    public let reviewModel: String
    public let maxDiffLines: Int
    public let taskTimeoutMs: Int
}

public enum SocketError: Error, Equatable {
    case malformedResponse
    case pathTooLong
    case io(Int32)
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

    public static func socketPath(in stateDirectory: String) -> String {
        (stateDirectory as NSString).appendingPathComponent("worker.sock")
    }

    public static func defaultSocketPath() -> String {
        socketPath(in: StateDirectory.resolve())
    }

    private func request(_ method: String, _ path: String) -> String {
        "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    }

    private func collect(_ method: String, _ path: String) async throws -> HTTPResponse {
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
