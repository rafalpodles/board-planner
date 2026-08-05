import Foundation

// Who owns the worker's lifetime. The app started it, so the app stops it — leaving an invisible
// background process running after its only interface has gone is the same complaint as an app you
// cannot quit, one level down.
//
// But only the one it started. A worker launched from a launchd plist, or by hand in a terminal,
// belongs to whoever launched it; the app is a convenience over that contract and does not get to
// end it. Holding the Process handle is what tells the two cases apart — there is no guessing by
// pid or by name.
@MainActor
final class RunningWorker {
    static let shared = RunningWorker()

    private var spawned: Process?

    var isOurs: Bool { spawned?.isRunning == true }

    func adopt(_ process: Process) {
        spawned = process
    }

    /// Stops the worker this app started, and waits for it to go. Returns false when there was
    /// nothing of ours to stop — which is the normal case for a worker started some other way.
    @discardableResult
    func stop(timeout: TimeInterval = 10) -> Bool {
        guard let process = spawned, process.isRunning else { return false }

        // SIGTERM, not SIGKILL: the worker's shutdown releases the task it holds with its attempt
        // refunded and drains its outbox. Killing it outright strands whatever it was running —
        // and since CP-230 it answers a term in a fraction of a second, so there is nothing to gain.
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
