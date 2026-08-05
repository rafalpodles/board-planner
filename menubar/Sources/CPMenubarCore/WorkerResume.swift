import Foundation

// An onboarded machine should have a worker running whenever the app does. Nothing was starting one
// after a relaunch: startWorker() ran once, at the end of the clone step, so quitting and reopening
// — or logging in, which is the entire point of registering as a login item — left the panel
// retrying a socket nobody was listening on, on a machine the fleet console still called connected.
public enum WorkerResume {
    public static func shouldStart(
        isOnboarded: Bool,
        weAlreadyStartedOne: Bool,
        somethingIsListening: Bool
    ) -> Bool {
        // Never a second one against the same state directory. Two workers share a credential and
        // both claim tasks; and a worker started from a plist or a terminal belongs to whoever
        // started it — the same line RunningWorker draws when it refuses to stop one.
        isOnboarded && !weAlreadyStartedOne && !somethingIsListening
    }
}
