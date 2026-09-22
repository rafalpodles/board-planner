import Foundation
import Testing
@testable import CPMenubarCore

private struct FakeTransport: Transport {
    let chunks: [String]

    func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            for chunk in chunks { continuation.yield(Data(chunk.utf8)) }
            continuation.finish()
        }
    }
}

private struct RecordingTransport: Transport {
    let body: String
    let seen: Recorder

    final class Recorder: @unchecked Sendable {
        var requests: [String] = []
    }

    func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error> {
        seen.requests.append(request)
        return AsyncThrowingStream { continuation in
            continuation.yield(Data("HTTP/1.1 200 OK\r\n\r\n\(body)".utf8))
            continuation.finish()
        }
    }
}

@Test func framesTwoEventsOutOfOneChunk() {
    var buffer = Data("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n".utf8)

    let events = sseEvents(from: &buffer)

    #expect(events.map { String(data: $0, encoding: .utf8) } == ["{\"a\":1}", "{\"b\":2}"])
    #expect(buffer.isEmpty)
}

// The failure that shows up only against a real worker: a chunk boundary lands mid-event.
@Test func holdsAPartialEventUntilItsTerminatorArrives() {
    var buffer = Data("data: {\"a\":".utf8)
    #expect(sseEvents(from: &buffer).isEmpty)

    buffer.append(Data("1}\n\n".utf8))

    #expect(sseEvents(from: &buffer).map { String(data: $0, encoding: .utf8) } == ["{\"a\":1}"])
}

@Test func parsesAStatusResponseOverTheTransport() async throws {
    let client = SocketClient(socketPath: "/x", transport: FakeTransport(chunks: [
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n",
        #"{"paused":true,"current":null,"recent":[]}"#,
    ]))

    let status = try await client.status()

    #expect(status.paused == true)
    #expect(status.current == nil)
}

@Test func parsesTheConfigResponse() async throws {
    let body = #"""
    {"apiUrl":"http://localhost:3991","workerName":"rig","projectCount":2,"pollIntervalMs":30000,
     "projects":[{"project":"p1","baseBranch":"main","model":"opus",
     "reviewModel":"sonnet","maxDiffLines":400,"taskTimeoutMs":900000}]}
    """#
    let client = SocketClient(socketPath: "/x",
                              transport: FakeTransport(chunks: ["HTTP/1.1 200 OK\r\n\r\n", body]))

    let config = try await client.config()

    #expect(config.workerName == "rig")
    #expect(config.pollIntervalMs == 30000)
    // Work settings are per project, so they are read from there and not from the top level
    #expect(config.projects.first?.maxDiffLines == 400)
    // The body above is a copy of what local-server.ts serves. It used to be written to match the
    // decoder instead, autoMerge and all, so it stayed green for years describing a payload no
    // worker sends — see ConfigDecodingTests for the fixture taken from a running one.
    // Also the BP-377 case: a worker older than that field sends neither key nor name, and the
    // fixture above still has to decode — which it does, since both are `String?`.
    #expect(config.projects.first?.key == nil)
    #expect(config.projects.first?.label == "p1")
}

// BP-377. What the Policy pane heads each project's block with, the same shape ProjectOffer's own
// label already uses.
@Test func namesABoundProjectTheWayAnOfferAlreadyDoes() async throws {
    let body = #"""
    {"apiUrl":"http://localhost:3991","workerName":"rig","projectCount":1,"pollIntervalMs":30000,
     "projects":[{"project":"p1","key":"TP","name":"Test Project","baseBranch":"main","model":"opus",
     "reviewModel":"sonnet","maxDiffLines":400,"taskTimeoutMs":900000}]}
    """#
    let client = SocketClient(socketPath: "/x",
                              transport: FakeTransport(chunks: ["HTTP/1.1 200 OK\r\n\r\n", body]))

    let config = try await client.config()

    #expect(config.projects.first?.label == "Test Project · TP")
}

@Test func fallsBackToWhicheverOfKeyAndNameItHas() {
    let named = ProjectConfig(
        project: "p1", key: nil, name: "Test Project", baseBranch: "main", model: "opus",
        reviewModel: "sonnet", maxDiffLines: 400, taskTimeoutMs: 900_000, blocked: nil)
    #expect(named.label == "Test Project")

    let keyed = ProjectConfig(
        project: "p1", key: "TP", name: nil, baseBranch: "main", model: "opus",
        reviewModel: "sonnet", maxDiffLines: 400, taskTimeoutMs: 900_000, blocked: nil)
    #expect(keyed.label == "TP")

    let neither = ProjectConfig(
        project: "p1", key: nil, name: nil, baseBranch: "main", model: "opus",
        reviewModel: "sonnet", maxDiffLines: 400, taskTimeoutMs: 900_000, blocked: nil)
    #expect(neither.label == "p1")
}

@Test func surfacesEventsFromASplitStream() async throws {
    let client = SocketClient(socketPath: "/x", transport: FakeTransport(chunks: [
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"pha",
        "se\":\"agent\"}\n\ndata: {\"outcome\":\"merged\",\"taskKey\":\"CP-1\"}\n\n",
    ]))

    var seen: [TelemetryEvent] = []
    for await event in client.stream() { seen.append(event) }

    #expect(seen == [
        .progress(Progress(phase: "agent")),
        .outcome(Outcome(outcome: "merged", taskKey: "CP-1")),
    ])
}

// The panel depends on this stream; one malformed frame must not end it.
@Test func ignoresAnEventItCannotDecodeRatherThanEndingTheStream() async throws {
    let client = SocketClient(socketPath: "/x", transport: FakeTransport(chunks: [
        "HTTP/1.1 200 OK\r\n\r\ndata: {\"nonsense\":1}\n\ndata: {\"phase\":\"push\"}\n\n",
    ]))

    var seen: [TelemetryEvent] = []
    for await event in client.stream() { seen.append(event) }

    #expect(seen == [.progress(Progress(phase: "push"))])
}

@Test func aCommandPostsAndReadsBackThePauseState() async throws {
    let recorder = RecordingTransport.Recorder()
    let client = SocketClient(socketPath: "/x",
                              transport: RecordingTransport(body: #"{"paused":true}"#, seen: recorder))

    let paused = try await client.command("pause")

    #expect(paused == true)
    #expect(recorder.requests.first?.hasPrefix("POST /pause HTTP/1.1") == true)
}

@Test func closesTheConnectionSoTheWorkerDoesNotHoldItOpen() async throws {
    let recorder = RecordingTransport.Recorder()
    let client = SocketClient(socketPath: "/x",
                              transport: RecordingTransport(body: #"{"paused":false}"#, seen: recorder))

    _ = try await client.command("resume")

    #expect(recorder.requests.first?.contains("Connection: close") == true)
}

// BP-778. The same input and the same answer as the worker's own test (worker/src/config.test.ts):
// the two sides derive the path independently and have to agree byte for byte.
@Test func movesTheSocketWhereTheWorkerDoesForADeepStateDirectory() {
    let deep = "/Users/operator/" + String(repeating: "nested/", count: 12) + "state"

    #expect(SocketClient.socketPath(in: deep, uid: 501)
            == "/tmp/cp-worker-501-7038366db39fb12e/worker.sock")
}

@Test func derivesOneSocketPathFromEverySpellingOfTheStateDirectory() {
    let spelled = "  /Users/operator/./x/../" + String(repeating: "nested/", count: 12) + "state/\n"

    #expect(SocketClient.socketPath(in: spelled, uid: 501)
            == "/tmp/cp-worker-501-7038366db39fb12e/worker.sock")
    #expect(SocketClient.socketPath(in: "/rig/./state/", uid: 501) == "/rig/state/worker.sock")
}

@Test func keepsTheSocketBesideAStateDirectoryShortEnoughForOne() {
    let dir = "/" + String(repeating: "a", count: 103 - "/worker.sock".count - 1)

    #expect(SocketClient.socketPath(in: dir, uid: 501) == dir + "/worker.sock")
    #expect(SocketClient.socketPath(in: dir + "b", uid: 501).hasPrefix("/tmp/cp-worker-501-"))
}

@Test func defaultsToTheWorkersOwnStateDirectory() {
    #expect(SocketClient.defaultSocketPath().hasSuffix("/worker.sock"))
}

// The shape the worker actually sends: chunked framing wrapped around each SSE write, with the
// read(2) boundary landing wherever it lands.
@Test func surfacesEventsFromAChunkedStream() async throws {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
    let first = "data: {\"phase\":\"agent\",\"taskKey\":\"CP-2\"}\n\n"
    let second = "data: {\"outcome\":\"merged\",\"taskKey\":\"CP-2\"}\n\n"
    let framed = "\(String(first.utf8.count, radix: 16))\r\n\(first)\r\n"
        + "\(String(second.utf8.count, radix: 16))\r\n\(second)\r\n"
    let cut = framed.index(framed.startIndex, offsetBy: 20)

    let client = SocketClient(socketPath: "/x", transport: FakeTransport(chunks: [
        head + String(framed[..<cut]),
        String(framed[cut...]),
    ]))

    var seen: [TelemetryEvent] = []
    for await event in client.stream() { seen.append(event) }

    #expect(seen == [
        .progress(Progress(phase: "agent", taskKey: "CP-2")),
        .outcome(Outcome(outcome: "merged", taskKey: "CP-2")),
    ])
}

@Test func decodesAChunkedStatusBody() async throws {
    let body = #"{"paused":false,"current":null,"recent":[]}"#
    let client = SocketClient(socketPath: "/x", transport: FakeTransport(chunks: [
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
            + "\(String(body.utf8.count, radix: 16))\r\n\(body)\r\n0\r\n\r\n",
    ]))

    let status = try await client.status()

    #expect(status.paused == false)
    #expect(status.recent.isEmpty)
}

// BP-778 review. The relocated socket lives under /tmp, where anyone could have made its directory
// before the worker ran; the app must not hand a pause, a resume or its trust to whatever answers.
private func scratchDirectory(mode: mode_t) throws -> String {
    let path = NSTemporaryDirectory() + "cp-socket-dir-" + UUID().uuidString
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false)
    chmod(path, mode)
    return path
}

@Test func acceptsAPrivateDirectoryOfThisUsers() throws {
    let dir = try scratchDirectory(mode: 0o700)
    defer { try? FileManager.default.removeItem(atPath: dir) }

    #expect(SocketClient.directoryRefusal(dir) == nil)
}

@Test func refusesADirectoryOtherUsersCanOpen() throws {
    let dir = try scratchDirectory(mode: 0o755)
    defer { try? FileManager.default.removeItem(atPath: dir) }

    #expect(SocketClient.directoryRefusal(dir)?.contains("can be opened by other users") == true)
}

@Test func refusesADirectoryAnotherUserOwns() throws {
    let dir = try scratchDirectory(mode: 0o700)
    defer { try? FileManager.default.removeItem(atPath: dir) }

    #expect(SocketClient.directoryRefusal(dir, uid: getuid() + 1)?.contains("belongs to another user") == true)
}

@Test func refusesASymlinkInPlaceOfTheDirectory() throws {
    let dir = try scratchDirectory(mode: 0o700)
    let link = dir + "-link"
    defer {
        try? FileManager.default.removeItem(atPath: link)
        try? FileManager.default.removeItem(atPath: dir)
    }
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: dir)

    #expect(SocketClient.directoryRefusal(link)?.contains("symbolic link") == true)
}

@Test func sendsNothingToARelocatedSocketInADirectoryOthersCanOpen() async throws {
    let dir = "/tmp/cp-worker-\(getuid())-test\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: false)
    chmod(dir, 0o777)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let recorder = RecordingTransport.Recorder()
    let client = SocketClient(socketPath: dir + "/worker.sock",
                              transport: RecordingTransport(body: #"{"paused":false}"#, seen: recorder))

    await #expect(throws: SocketError.self) { _ = try await client.command("pause") }
    #expect(recorder.requests.isEmpty)
}

@Test func leavesAStateDirectorySocketToTheOperator() {
    #expect(SocketClient.unsafeDirectoryReason(forSocketAt: "/Users/someone/.boardplanner/worker.sock") == nil)
}

// BP-778 review, D1: the directory check runs before connect(2), and /tmp is shared — a local
// attacker looping create and delete on that directory eventually wins the gap. The peer's uid is
// asked of the connection itself, so whoever answers is checked rather than whatever was on disk.
@Test func acceptsAPeerRunningAsThisUser() {
    #expect(POSIXTransport.peerRefusal(peer: getuid(), ours: getuid()) == nil)
}

@Test func refusesAPeerRunningAsAnotherUser() {
    let refusal = POSIXTransport.peerRefusal(peer: getuid() + 1, ours: getuid())

    #expect(refusal?.contains("not your worker") == true)
    #expect(refusal?.contains("uid \(getuid() + 1)") == true)
}

// The control, and the proof the check is on the live path: a socket this user really owns answers.
@Test func readsFromASocketThisUserOwns() async throws {
    let path = NSTemporaryDirectory() + "cp-peer-\(UUID().uuidString.prefix(8)).sock"
    defer { unlink(path) }
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    #expect(listener >= 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    withUnsafeMutablePointer(to: &address.sun_path) { field in
        field.withMemoryRebound(to: CChar.self, capacity: capacity) { target in
            for (offset, byte) in bytes.enumerated() { target[offset] = CChar(bitPattern: byte) }
            target[bytes.count] = 0
        }
    }
    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
            bind(listener, generic, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    #expect(bound == 0)
    #expect(listen(listener, 1) == 0)
    let answering = Task.detached {
        let accepted = accept(listener, nil, nil)
        let reply = "HTTP/1.1 200 OK\r\n\r\n{\"paused\":false}"
        _ = Array(reply.utf8).withUnsafeBufferPointer { write(accepted, $0.baseAddress, $0.count) }
        close(accepted)
    }
    defer {
        close(listener)
        answering.cancel()
    }

    var received = Data()
    for try await chunk in try await POSIXTransport().send("GET /status HTTP/1.1\r\n\r\n", to: path) {
        received.append(chunk)
    }

    #expect(String(data: received, encoding: .utf8)?.contains("paused") == true)
}
