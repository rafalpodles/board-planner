import Foundation
import XCTest
@testable import CPMenubarCore

final class ForgettingAnIdentityTests: XCTestCase {
    private func scratch() throws -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("worker.json").path
    }

    // A credential is minted by one board and refused by every other, so changing boards has to
    // drop it. A file left behind is one a restarted worker would present to a server that says no.
    func testItForgetsTheCredential() throws {
        let file = IdentityFile(path: try scratch())
        try file.write(WorkerIdentity(workerId: "w1", credential: "cpw_secret", heartbeatMs: 60_000))

        try file.forget()

        XCTAssertNil(try file.read())
    }

    // Forgetting something that is not there is the state being asked for, not a failure
    func testForgettingWhatIsNotThereIsFine() throws {
        XCTAssertNoThrow(try IdentityFile(path: try scratch()).forget())
    }
}
