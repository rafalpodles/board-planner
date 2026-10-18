import Foundation

/// Why Connect is not offered yet, in the words the screen says next to it, or nil when it is.
/// Ordered the way the screen reads, top to bottom, so the reason is always the first thing the
/// operator would have to do.
public enum ConnectReadiness {
    public static func blocker(
        apiURL: String, checkoutsFolder: String, preflightRan: Bool, failingChecks: [String], busy: Bool
    ) -> String? {
        if busy { return "Working…" }
        if apiURL.trimmingCharacters(in: .whitespaces).isEmpty { return "Enter the board's address." }
        if checkoutsFolder.isEmpty { return "Choose a checkouts folder." }
        if !preflightRan { return "Check this machine first." }
        switch failingChecks.count {
        case 0: return nil
        case 1: return "Fix the \(failingChecks[0]) check first."
        default: return "Fix \(failingChecks.count) checks first: \(failingChecks.joined(separator: ", "))."
        }
    }
}
