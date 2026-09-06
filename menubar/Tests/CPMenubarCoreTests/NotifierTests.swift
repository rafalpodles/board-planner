import Testing
@testable import CPMenubarCore

@Test func notifiesOnAMerge() {
    let request = notification(for: .outcome(Outcome(outcome: "merged", taskKey: "CP-1")))

    #expect(request?.title == "CP-1 merged")
}

@Test func notifiesOnAGateRejectionAndNamesTheGate() {
    let request = notification(
        for: .outcome(Outcome(outcome: "gateRejected", taskKey: "CP-1", detail: "build")))

    #expect(request?.title == "CP-1 rejected by the build gate")
}

@Test func namesTheGateAsUnknownRatherThanDroppingTheNotification() {
    let request = notification(for: .outcome(Outcome(outcome: "gateRejected", taskKey: "CP-1")))

    #expect(request != nil)
}

@Test func notifiesWhenATaskNeedsAHuman() {
    let request = notification(
        for: .outcome(Outcome(outcome: "blocked", taskKey: "CP-1", detail: "ambiguous scope")))

    #expect(request?.title == "CP-1 needs a human")
    #expect(request?.body == "ambiguous scope")
}

@Test func notifiesWhenTheUsageLimitIsHit() {
    #expect(notification(for: .quota(Quota(status: "rejected")))?.title == "Usage limit reached")
}

@Test func staysSilentOnAWarningThatIsNotYetALimit() {
    #expect(notification(for: .quota(Quota(status: "allowed_warning", utilization: 0.9))) == nil)
}

@Test func staysSilentOnAnAllowedQuotaReading() {
    #expect(notification(for: .quota(Quota(status: "allowed"))) == nil)
}

@Test func staysSilentOnOrdinaryProgress() {
    #expect(notification(for: .progress(Progress(phase: "agent"))) == nil)
}

@Test func staysSilentOnARequeue() {
    #expect(notification(for: .outcome(Outcome(outcome: "requeued", taskKey: "CP-1"))) == nil)
}

@Test func staysSilentOnAReleaseAndAFailure() {
    #expect(notification(for: .outcome(Outcome(outcome: "released", taskKey: "CP-1"))) == nil)
    #expect(notification(for: .outcome(Outcome(outcome: "failed", taskKey: "CP-1"))) == nil)
}

@Test func notifiesWhenAPullRequestIsWaiting() {
    let request = notification(
        for: .outcome(Outcome(outcome: "delivered", taskKey: "CP-3", detail: "https://x/pull/7")))

    #expect(request?.title == "CP-3 is ready for review")
    #expect(request?.body == "https://x/pull/7")
}

@Test func fallsBackToPlainWordingWhenNoUrlCameThrough() {
    let request = notification(for: .outcome(Outcome(outcome: "delivered", taskKey: "CP-3")))

    #expect(request?.body.contains("did not merge") == true)
}
