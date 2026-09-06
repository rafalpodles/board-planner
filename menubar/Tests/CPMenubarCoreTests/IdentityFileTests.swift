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

    func testItForgetsTheCredential() throws {
        let file = IdentityFile(path: try scratch())
        try file.write(WorkerIdentity(workerId: "w1", credential: "cpw_secret", heartbeatMs: 60_000))

        try file.forget()

        XCTAssertNil(try file.read())
    }

    func testForgettingWhatIsNotThereIsFine() throws {
        XCTAssertNoThrow(try IdentityFile(path: try scratch()).forget())
    }
}
