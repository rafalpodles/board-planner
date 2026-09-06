import XCTest
@testable import CPMenubarCore

final class DeviceEnrolmentTests: XCTestCase {
    private func client(
        status: Int,
        body: String,
        capture: (@Sendable (URLRequest) -> Void)? = nil
    ) -> DeviceEnrolmentClient {
        DeviceEnrolmentClient(apiURL: "https://app.example.com") { request in
            capture?(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), response)
        }
    }

    func testBeginningAsksForTheMachineByName() async throws {
        let seen = SendableBox<URLRequest?>(nil)
        let sut = client(
            status: 201,
            body: #"{"deviceCode":"cpd_x","userCode":"BCDF-2345","verificationUrl":"https://app/enrol/BCDF2345","intervalMs":2000}"#,
            capture: { seen.value = $0 })

        let started = try await sut.begin(machineName: "owner-macbook", machineHost: "mac.local")

        XCTAssertEqual(started.userCode, "BCDF-2345")
        XCTAssertEqual(started.verificationUrl, "https://app/enrol/BCDF2345")
        XCTAssertEqual(seen.value?.url?.path, "/api/workers/enrolment/device")
        let body = try XCTUnwrap(seen.value?.httpBody)
        let sent = try JSONSerialization.jsonObject(with: body) as? [String: String]
        XCTAssertEqual(sent?["name"], "owner-macbook")
        XCTAssertEqual(sent?["host"], "mac.local")
    }

    func testItSpeaksTheProtocolVersion() async throws {
        let seen = SendableBox<URLRequest?>(nil)
        let sut = client(
            status: 201,
            body: #"{"deviceCode":"c","userCode":"u","verificationUrl":"v","intervalMs":2000}"#,
            capture: { seen.value = $0 })

        _ = try await sut.begin(machineName: "m", machineHost: "h")

        XCTAssertEqual(seen.value?.value(forHTTPHeaderField: "X-CP-Protocol"), "1")
    }

    func testPollingReportsPendingWhileNobodyHasApproved() async throws {
        let sut = client(status: 200, body: #"{"state":"pending"}"#)

        let result = try await sut.poll(deviceCode: "cpd_x")
        XCTAssertEqual(result, .pending)
    }

    func testPollingHandsBackTheCredential() async throws {
        let sut = client(
            status: 200,
            body: #"{"state":"approved","workerId":"w1","credential":"cpw_secret","heartbeatMs":60000,"repositoryUrl":"https://github.com/o/r","projectKey":"TP"}"#)

        let result = try await sut.poll(deviceCode: "cpd_x")
        XCTAssertEqual(result, .approved(workerID: "w1", credential: "cpw_secret", heartbeatMs: 60000, repositoryURL: "https://github.com/o/r", projectKey: "TP"))
    }

    // Refused, expired, or already collected all answer 410 — the server does not distinguish them
    // on purpose, so neither does this: start again.
    func testAFinishedExchangeIsOneOutcome() async throws {
        let sut = client(status: 410, body: #"{"state":"expired"}"#)

        let result = try await sut.poll(deviceCode: "cpd_x")
        XCTAssertEqual(result, .finished)
    }

    func testAnApprovalWithoutACredentialIsRefusedRatherThanHalfAccepted() async {
        let sut = client(status: 200, body: #"{"state":"approved","workerId":"w1"}"#)

        do {
            _ = try await sut.poll(deviceCode: "cpd_x")
            XCTFail("a credential-less approval must not be treated as success")
        } catch {
            XCTAssertEqual(error as? DeviceEnrolmentError, .malformed)
        }
    }

    func testAServerErrorIsNotMistakenForAnAnswer() async {
        let sut = client(status: 500, body: "boom")

        do {
            _ = try await sut.poll(deviceCode: "cpd_x")
            XCTFail("a 500 is not an outcome")
        } catch {
            XCTAssertEqual(error as? DeviceEnrolmentError, .badResponse(500))
        }
    }

    func testATrailingSlashOnTheApiUrlDoesNotDoubleUp() async throws {
        let seen = SendableBox<URLRequest?>(nil)
        let sut = DeviceEnrolmentClient(apiURL: "https://app.example.com/") { request in
            seen.value = request
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (Data(#"{"state":"pending"}"#.utf8), response)
        }

        _ = try await sut.poll(deviceCode: "cpd_x")

        XCTAssertEqual(seen.value?.url?.absoluteString, "https://app.example.com/api/workers/enrolment/device/token")
    }
}

/// Small mutable box so a capture closure can hand a value back out of a `@Sendable` context.
final class SendableBox<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
