import Testing
@testable import CPMenubarCore

private func blocker(
    api: String = "app.board-planner.com", folder: String = "/w", ran: Bool = true,
    failing: [String] = [], busy: Bool = false
) -> String? {
    ConnectReadiness.blocker(apiURL: api, checkoutsFolder: folder, preflightRan: ran, failingChecks: failing, busy: busy)
}

@Test func aMachineThatPassedEverythingHasNothingBlockingIt() {
    #expect(blocker() == nil)
}

@Test func theFirstThingToDoIsTheOneItNames() {
    #expect(blocker(api: "  ", folder: "", ran: false) == "Enter the board's address.")
    #expect(blocker(folder: "", ran: false) == "Choose a checkouts folder.")
    #expect(blocker(ran: false) == "Check this machine first.")
}

@Test func aFailedCheckIsNamedSoTheFixIsNotAGuess() {
    #expect(blocker(failing: ["claude"]) == "Fix the claude check first.")
    #expect(blocker(failing: ["claude", "gh"]) == "Fix 2 checks first: claude, gh.")
}

@Test func workInProgressOutranksEverythingElse() {
    #expect(blocker(api: "", folder: "", ran: false, failing: ["claude"], busy: true) == "Working…")
}
