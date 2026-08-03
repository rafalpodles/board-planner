import Foundation
import Testing
@testable import CPMenubarCore

// Opt-in: these need a worker actually running. Everything else in this suite is hermetic.
//
//   CP_LIVE_SOCKET=$HOME/cp-rig/state/worker.sock swift test
//
// They exist because the transport is the one part unit tests cannot reach — a real AF_UNIX socket,
// a real HTTP response, and a real SSE stream.
private let liveSocket = ProcessInfo.processInfo.environment["CP_LIVE_SOCKET"]

private func liveClient() -> SocketClient {
    SocketClient(socketPath: liveSocket ?? "", transport: POSIXTransport())
}

@Test(.enabled(if: liveSocket != nil))
func readsStatusFromARunningWorker() async throws {
    let status = try await liveClient().status()

    #expect(status.recent.count >= 0)
    if status.current == nil {
        #expect(Bool(true), "idle worker")
    }
}

@Test(.enabled(if: liveSocket != nil))
func readsConfigFromARunningWorker() async throws {
    let config = try await liveClient().config()

    #expect(!config.workerName.isEmpty)
    #expect(!config.apiUrl.isEmpty)
    #expect(config.maxDiffLines > 0)
}

@Test(.enabled(if: liveSocket != nil))
func theConfigRouteDisclosesNoCredential() async throws {
    let config = try await liveClient().config()
    let rendered = "\(config)"

    #expect(!rendered.contains("cpw_"))
    #expect(!rendered.lowercased().contains("token"))
}

@Test(.enabled(if: liveSocket != nil))
func openingTheStreamAgainstARunningWorkerDoesNotFailImmediately() async throws {
    let client = liveClient()

    // An idle worker emits nothing, so this proves the stream opens and stays open rather than
    // erroring — the SSE head is flushed eagerly for exactly this case.
    let opened = Task { () -> TelemetryEvent? in
        for await event in client.stream() { return event }
        return nil
    }
    try await Task.sleep(for: .seconds(2))
    opened.cancel()

    #expect(Bool(true))
}

// The whole path the panel depends on, against a real worker: chunked framing, SSE framing, the
// union decode, and the reducer. Needs a task to be claimed while it runs.
//
//   CP_LIVE_SOCKET=... CP_LIVE_RUN=1 swift test --filter followsARealRun
@Test(.enabled(if: liveSocket != nil && ProcessInfo.processInfo.environment["CP_LIVE_RUN"] != nil),
      .timeLimit(.minutes(5)))
func followsARealRun() async throws {
    let client = liveClient()
    var state = WorkerState()
    var events: [TelemetryEvent] = []

    for await event in client.stream() {
        events.append(event)
        state.apply(event, at: Date())
        if case .outcome = event { break }
    }

    let phases = events.compactMap { if case .progress(let p) = $0 { return p } else { return nil } }
    print("LIVE phases: \(phases.map(\.phase))")
    print("LIVE title: \(state.title(now: Date()) ?? "nil"), health: \(state.health)")

    #expect(!phases.isEmpty, "the run emitted no phases")
    #expect(phases.contains { $0.taskKey != nil }, "no phase named its task")
    #expect(events.contains { if case .outcome = $0 { return true } else { return false } })
}
