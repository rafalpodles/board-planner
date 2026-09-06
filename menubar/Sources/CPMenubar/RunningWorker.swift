import Foundation

@MainActor
final class RunningWorker {
    static let shared = RunningWorker()

    private var spawned: Process?

    var isOurs: Bool { spawned?.isRunning == true }

    func adopt(_ process: Process) {
        spawned = process
    }

    @discardableResult
    func stop(timeout: TimeInterval = 10) -> Bool {
        guard let process = spawned, process.isRunning else { return false }

        process.terminate()

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }

        spawned = nil
        return true
    }
}
