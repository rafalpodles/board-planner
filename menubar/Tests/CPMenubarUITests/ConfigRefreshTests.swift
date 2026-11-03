import CPMenubarCore
import Foundation
import XCTest
@testable import CPMenubar

private final class ServedConfig: @unchecked Sendable {
    private let lock = NSLock()
    private var held = ""
    var heldJSON: String {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}

private struct WorkerSocket: Transport {
    let served: ServedConfig

    func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error> {
        let route = request.split(separator: " ")[1]
        return AsyncThrowingStream { continuation in
            switch route {
            case "/status":
                continuation.yield(Data(#"HTTP/1.1 200 OK\#r\#n\#r\#n{"paused":false,"current":null,"recent":[]}"#.utf8))
                continuation.finish()
            case "/config":
                let held = served.heldJSON.isEmpty ? "" : #","held":[\#(served.heldJSON)]"#
                let body = """
                {"apiUrl":"http://localhost","workerName":"w","projectCount":1,"pollIntervalMs":30000,
                 "projects":[{"project":"p1","key":"BP","name":"Board Planner","baseBranch":"main","model":"opus","reviewModel":"opus","maxDiffLines":400,"taskTimeoutMs":1800000,"blocked":""\(held)}]}
                """
                continuation.yield(Data("HTTP/1.1 200 OK\r\n\r\n\(body)".utf8))
                continuation.finish()
            default:
                continuation.yield(Data("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n".utf8))
            }
        }
    }
}

@MainActor
final class ConfigRefreshTests: XCTestCase {
    func testAHoldThatStartsAndLiftsOnAnOpenSocketReachesTheProjectsTab() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let served = ServedConfig()
        let model = AppModel(
            client: SocketClient(socketPath: directory.appendingPathComponent("worker.sock").path, transport: WorkerSocket(served: served)),
            configRefresh: .milliseconds(20))
        model.start()
        defer { model.stop() }

        try await until { model.config?.projects.first?.claimState == .ready }
        served.heldJSON = #"{"agent":"Ship it","reason":"no test command"}"#
        try await until { model.config?.projects.first?.claimState == .holding }
        served.heldJSON = ""
        try await until { model.config?.projects.first?.claimState == .ready }
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            if Date() > deadline { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
