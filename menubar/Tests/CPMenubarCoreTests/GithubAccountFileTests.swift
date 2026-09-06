import Foundation
import Testing
@testable import CPMenubarCore

private func scratch() throws -> String {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("github.json").path
}

@Test func readsNoAccountWhenTheFileDoesNotExist() throws {
    #expect(try GithubAccountFile(path: scratch()).read() == "")
}

@Test func roundTripsTheLoginTheWorkerReads() throws {
    let file = GithubAccountFile(path: try scratch())
    try file.write("rafalpodles")

    #expect(try file.read() == "rafalpodles")
}

@Test func writesTheExactJsonShapeTheWorkerExpects() throws {
    let path = try scratch()
    try GithubAccountFile(path: path).write("rafalpodles")

    let parsed = try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: String]

    #expect(parsed?["account"] == "rafalpodles")
}

@Test func clearingThePinLeavesAFileTheWorkerReadsAsUnpinned() throws {
    let path = try scratch()
    let file = GithubAccountFile(path: path)
    try file.write("rafalpodles")

    try file.write("")

    #expect(try file.read() == "")
    #expect(FileManager.default.fileExists(atPath: path))
}

@Test func writesTheAccountAtOwnerOnlyPermissions() throws {
    let path = try scratch()
    try GithubAccountFile(path: path).write("rafalpodles")

    let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber

    #expect(mode?.int16Value == 0o600)
}

@Test func readsNothingOutOfAFileThatIsNotTheRightShape() throws {
    let path = try scratch()
    try Data("{ not json".utf8).write(to: URL(fileURLWithPath: path))

    #expect(try GithubAccountFile(path: path).read() == "")
}
