import Darwin
import Foundation

public struct HTTPResponse: Sendable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

public func parseHead(_ bytes: Data) -> (status: Int, headerLength: Int, chunked: Bool)? {
    guard let terminator = bytes.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    guard let text = String(data: bytes[..<terminator.lowerBound], encoding: .utf8) else { return nil }

    let lines = text.components(separatedBy: "\r\n")
    let fields = (lines.first ?? "").split(separator: " ")
    guard fields.count >= 2, fields[0].hasPrefix("HTTP/"), let status = Int(fields[1]) else {
        return nil
    }

    let chunked = lines.dropFirst().contains { line in
        let parts = line.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return false }
        return parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "transfer-encoding"
            && parts[1].lowercased().contains("chunked")
    }

    return (status, bytes.distance(from: bytes.startIndex, to: terminator.upperBound), chunked)
}

// Node sets no Content-Length on any socket route, so every body arrives chunked — including the
// SSE stream, where a chunk boundary can land anywhere inside an event.
public func dechunk(from buffer: inout Data) -> (data: Data, finished: Bool) {
    let crlf = Data("\r\n".utf8)
    var decoded = Data()

    while true {
        guard let sizeLineEnd = buffer.range(of: crlf) else { return (decoded, false) }

        let sizeLine = buffer[..<sizeLineEnd.lowerBound]
        guard let sizeText = String(data: sizeLine, encoding: .utf8) else { return (decoded, false) }
        // A chunk extension (";name=value") follows the size and is not part of it
        let digits = sizeText.split(separator: ";", maxSplits: 1).first.map(String.init) ?? sizeText
        guard let size = Int(digits.trimmingCharacters(in: .whitespaces), radix: 16) else {
            return (decoded, false)
        }

        let bodyStart = sizeLineEnd.upperBound
        let needed = size + crlf.count
        guard buffer.distance(from: bodyStart, to: buffer.endIndex) >= needed else {
            return (decoded, false)
        }

        if size == 0 {
            buffer.removeAll()
            return (decoded, true)
        }

        let bodyEnd = buffer.index(bodyStart, offsetBy: size)
        decoded.append(buffer[bodyStart..<bodyEnd])
        buffer.removeSubrange(..<buffer.index(bodyEnd, offsetBy: crlf.count))
    }
}

public protocol Transport: Sendable {
    func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error>
}

// AF_UNIX, spoken directly. URLSession cannot address a unix socket at all, and NWConnection with
// `using: .tcp` stands up an IP stack that returns ENETDOWN against a unix endpoint — found against
// a running worker, not in a test.
public struct POSIXTransport: Transport {
    private let queue = DispatchQueue(label: "com.claudeplanner.menubar.socket", qos: .utility)

    public init() {}

    public func send(
        _ request: String,
        to path: String
    ) async throws -> AsyncThrowingStream<Data, Error> {
        let descriptor = try Self.connect(to: path)
        return AsyncThrowingStream { continuation in
            queue.async {
                defer { close(descriptor) }
                do {
                    try Self.writeAll(descriptor, Data(request.utf8))
                } catch {
                    continuation.finish(throwing: error)
                    return
                }

                var buffer = [UInt8](repeating: 0, count: 64 * 1024)
                while true {
                    let count = read(descriptor, &buffer, buffer.count)
                    if count > 0 {
                        continuation.yield(Data(buffer[..<count]))
                        continue
                    }
                    if count == 0 { break }
                    if errno == EINTR { continue }
                    continuation.finish(throwing: SocketError.io(errno))
                    return
                }
                continuation.finish()
            }
            // Reading blocks in read(2), so shutdown is what actually unblocks it; close alone
            // would leave the loop parked on a descriptor number that may be reused.
            continuation.onTermination = { _ in shutdown(descriptor, SHUT_RDWR) }
        }
    }

    private static func connect(to path: String) throws -> Int32 {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw SocketError.io(errno) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count < capacity else {
            close(descriptor)
            throw SocketError.pathTooLong
        }
        withUnsafeMutablePointer(to: &address.sun_path) { field in
            field.withMemoryRebound(to: CChar.self, capacity: capacity) { target in
                for (offset, byte) in bytes.enumerated() { target[offset] = CChar(bitPattern: byte) }
                target[bytes.count] = 0
            }
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                Darwin.connect(descriptor, generic, size)
            }
        }
        guard result == 0 else {
            let failure = errno
            close(descriptor)
            throw SocketError.io(failure)
        }
        return descriptor
    }

    private static func writeAll(_ descriptor: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let count = write(descriptor, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                if count > 0 {
                    sent += count
                    continue
                }
                if count < 0 && errno == EINTR { continue }
                throw SocketError.io(errno)
            }
        }
    }
}
