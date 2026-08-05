import Foundation

public struct DeviceEnrolmentStart: Decodable, Equatable, Sendable {
    public let deviceCode: String
    public let userCode: String
    public let verificationUrl: String
    public let intervalMs: Int
}

public enum DeviceEnrolmentPoll: Equatable, Sendable {
    case pending
    case approved(workerID: String, credential: String, heartbeatMs: Int)
    /// Refused, expired, or already collected. The server answers these alike on purpose, so the
    /// app treats them alike too: start again.
    case finished
}

public enum DeviceEnrolmentError: Error, Equatable {
    case badResponse(Int)
    case malformed
}

private struct PollBody: Decodable {
    let state: String
    let workerId: String?
    let credential: String?
    let heartbeatMs: Int?
}

// The app's half of CP-237: begin, open the browser, poll. Nothing here is authenticated, because
// the machine has nothing to authenticate with yet — that is the problem being solved. What it
// receives is worth nothing until an admin approves it in a browser.
public struct DeviceEnrolmentClient: Sendable {
    public typealias Send = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let apiURL: String
    private let send: Send

    public init(apiURL: String, send: @escaping Send = { try await URLSession.shared.data(for: $0) }) {
        self.apiURL = apiURL.hasSuffix("/") ? String(apiURL.dropLast()) : apiURL
        self.send = send
    }

    private func request(_ path: String, body: [String: String]) throws -> URLRequest {
        guard let url = URL(string: apiURL + path) else { throw DeviceEnrolmentError.malformed }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("1", forHTTPHeaderField: "X-CP-Protocol")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    public func begin(machineName: String, machineHost: String) async throws -> DeviceEnrolmentStart {
        let (data, response) = try await send(
            try request("/api/workers/enrolment/device", body: ["name": machineName, "host": machineHost]))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 201 || status == 200 else { throw DeviceEnrolmentError.badResponse(status) }
        return try JSONDecoder().decode(DeviceEnrolmentStart.self, from: data)
    }

    public func poll(deviceCode: String) async throws -> DeviceEnrolmentPoll {
        let (data, response) = try await send(
            try request("/api/workers/enrolment/device/token", body: ["deviceCode": deviceCode]))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0

        // 410 is the server saying this exchange is over, whichever way it ended
        if status == 410 { return .finished }
        guard status == 200 else { throw DeviceEnrolmentError.badResponse(status) }

        let body = try JSONDecoder().decode(PollBody.self, from: data)
        switch body.state {
        case "pending":
            return .pending
        case "approved":
            guard let workerID = body.workerId, let credential = body.credential else {
                throw DeviceEnrolmentError.malformed
            }
            return .approved(
                workerID: workerID, credential: credential, heartbeatMs: body.heartbeatMs ?? 60_000)
        default:
            return .finished
        }
    }
}
