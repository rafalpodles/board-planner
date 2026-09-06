import Foundation
import Testing
@testable import CPMenubarCore

private func decode(_ json: String) throws -> TelemetryEvent {
    try JSONDecoder().decode(TelemetryEvent.self, from: Data(json.utf8))
}

@Test func decodesProgressWithATaskAndATool() throws {
    let event = try decode(#"{"phase":"agent","taskKey":"CP-1","tool":{"name":"Read","target":"src/a.ts"}}"#)

    #expect(event == .progress(Progress(phase: "agent", taskKey: "CP-1",
                                        tool: ToolActivity(name: "Read", target: "src/a.ts"))))
}

@Test func decodesAnOpenEndedGatePhase() throws {
    #expect(try decode(#"{"phase":"gates:build","taskKey":"CP-1"}"#)
            == .progress(Progress(phase: "gates:build", taskKey: "CP-1")))
}

@Test func decodesAProgressThatCarriesNoTask() throws {
    #expect(try decode(#"{"phase":"agent"}"#) == .progress(Progress(phase: "agent")))
}

@Test func decodesQuotaByItsStatusKey() throws {
    #expect(try decode(#"{"status":"allowed_warning","utilization":0.91}"#)
            == .quota(Quota(status: "allowed_warning", utilization: 0.91)))
}

@Test func decodesAnOutcomeByItsOutcomeKey() throws {
    #expect(try decode(#"{"outcome":"gateRejected","taskKey":"CP-1","detail":"build"}"#)
            == .outcome(Outcome(outcome: "gateRejected", taskKey: "CP-1", detail: "build")))
}

@Test func throwsOnAnObjectThatIsNoneOfTheThree() {
    #expect(throws: (any Error).self) { try decode(#"{"unrelated":1}"#) }
}

@Test func decodesTheStatusResponse() throws {
    let json = #"{"paused":false,"current":{"phase":"agent"},"recent":[{"phase":"claiming"},{"phase":"agent"}]}"#
    let status = try JSONDecoder().decode(StatusResponse.self, from: Data(json.utf8))

    #expect(status.paused == false)
    #expect(status.current?.phase == "agent")
    #expect(status.recent.count == 2)
}

@Test func decodesAStatusResponseWithNothingRunning() throws {
    let status = try JSONDecoder().decode(
        StatusResponse.self, from: Data(#"{"paused":true,"current":null,"recent":[]}"#.utf8))

    #expect(status.paused == true)
    #expect(status.current == nil)
    #expect(status.recent.isEmpty)
}
