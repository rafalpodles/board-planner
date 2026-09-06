import Foundation

public enum WorkerResume {
    public static func shouldStart(
        isOnboarded: Bool,
        weAlreadyStartedOne: Bool,
        somethingIsListening: Bool
    ) -> Bool {
        isOnboarded && !weAlreadyStartedOne && !somethingIsListening
    }
}
