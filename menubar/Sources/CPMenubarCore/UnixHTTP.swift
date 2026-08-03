import Foundation
import Network

public struct HTTPResponse: Sendable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

public func parseHead(_ bytes: Data) -> (status: Int, headerLength: Int)? {
    guard let terminator = bytes.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    guard let text = String(data: bytes[..<terminator.lowerBound], encoding: .utf8) else { return nil }

    let statusLine = text.split(separator: "\r\n", maxSplits: 1).first ?? ""
    let fields = statusLine.split(separator: " ")
    guard fields.count >= 2, fields[0].hasPrefix("HTTP/"), let status = Int(fields[1]) else {
        return nil
    }
    return (status, bytes.distance(from: bytes.startIndex, to: terminator.upperBound))
}

public protocol Transport: Sendable {
    func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error>
}

// URLSession cannot address a unix socket at all, which is why this is Network.framework.
public struct NWTransport: Transport {
    public init() {}

    public func send(
        _ request: String,
        to path: String
    ) async throws -> AsyncThrowingStream<Data, Error> {
        let connection = NWConnection(to: .unix(path: path), using: .tcp)
        return AsyncThrowingStream { continuation in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.send(content: Data(request.utf8), completion: .idempotent)
                    Self.receive(connection, continuation)
                case .failed(let error):
                    continuation.finish(throwing: error)
                case .cancelled:
                    continuation.finish()
                default:
                    break
                }
            }
            continuation.onTermination = { _ in connection.cancel() }
            connection.start(queue: .global(qos: .utility))
        }
    }

    private static func receive(
        _ connection: NWConnection,
        _ continuation: AsyncThrowingStream<Data, Error>.Continuation
    ) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, done, error in
            if let data, !data.isEmpty { continuation.yield(data) }
            if let error {
                continuation.finish(throwing: error)
                return
            }
            if done {
                continuation.finish()
                return
            }
            receive(connection, continuation)
        }
    }
}
