import AppKit
import XCTest
@testable import CPMenubar

@MainActor
final class AppDelegateTests: XCTestCase {
    private func sleeper() throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["60"]
        try process.run()
        return process
    }

    private func terminate() {
        AppDelegate().applicationWillTerminate(
            Notification(name: NSApplication.willTerminateNotification))
    }

    func testTerminatingTheAppStopsTheWorkerItStartedWithSigterm() throws {
        let worker = try sleeper()
        defer { if worker.isRunning { kill(worker.processIdentifier, SIGKILL) } }
        RunningWorker.shared.adopt(worker)

        terminate()
        worker.waitUntilExit()

        XCTAssertEqual(worker.terminationReason, .uncaughtSignal)
        XCTAssertEqual(worker.terminationStatus, SIGTERM)
        XCTAssertFalse(RunningWorker.shared.isOurs)
    }

    func testTerminatingTheAppLeavesAWorkerItDidNotStartRunning() throws {
        let foreign = try sleeper()
        defer { if foreign.isRunning { kill(foreign.processIdentifier, SIGKILL) } }

        terminate()

        XCTAssertTrue(foreign.isRunning)
    }
}
