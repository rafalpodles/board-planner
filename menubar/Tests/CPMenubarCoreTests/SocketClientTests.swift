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
     "projects":[{"project":"p1","autoMerge":false,"baseBranch":"main","model":"opus",
     "reviewModel":"sonnet","maxDiffLines":400,"taskTimeoutMs":900000}]}
    """#
    let client = SocketClient(socketPath: "/x",
                              transport: FakeTransport(chunks: ["HTTP/1.1 200 OK\r\n\r\n", body]))

    let config = try await client.config()

    #expect(config.workerName == "rig")
    #expect(config.pollIntervalMs == 30000)
    // Work settings are per project, so they are read from there and not from the top level
    #expect(config.projects.first?.maxDiffLines == 400)
    #expect(config.projects.first?.autoMerge == false)
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
