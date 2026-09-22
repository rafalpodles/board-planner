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
    try file.write("owner")

    #expect(try file.read() == "owner")
}

// github-account.ts reads {"account": "..."}; any other shape and the pin is silently ignored,
// which is a worker pushing as the wrong identity with nothing on screen to say so.
@Test func writesTheExactJsonShapeTheWorkerExpects() throws {
    let path = try scratch()
    try GithubAccountFile(path: path).write("owner")

    let parsed = try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: String]

    #expect(parsed?["account"] == "owner")
}

// Picking "whichever gh has active" back is a real choice, not the absence of one: it has to
// survive a relaunch the same way a pinned login does.
@Test func clearingThePinLeavesAFileTheWorkerReadsAsUnpinned() throws {
    let path = try scratch()
    let file = GithubAccountFile(path: path)
    try file.write("owner")

    try file.write("")

    #expect(try file.read() == "")
    #expect(FileManager.default.fileExists(atPath: path))
}

@Test func writesTheAccountAtOwnerOnlyPermissions() throws {
    let path = try scratch()
    try GithubAccountFile(path: path).write("owner")

    let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber

    #expect(mode?.int16Value == 0o600)
}

@Test func readsNothingOutOfAFileThatIsNotTheRightShape() throws {
    let path = try scratch()
    try Data("{ not json".utf8).write(to: URL(fileURLWithPath: path))

    #expect(try GithubAccountFile(path: path).read() == "")
}

// BP-779. The worker commits as a name and address set beside the pin; picking the same account
// again in the app must not quietly drop them, and picking another must not carry them over.
@Test func keepsAHandSetIdentityOnlyForTheAccountItWasSetFor() throws {
    let path = try scratch()
    try Data(#"{"account":"owner","name":"Owner","email":"owner@example.org"}"#.utf8)
        .write(to: URL(fileURLWithPath: path))
    let file = GithubAccountFile(path: path)

    try file.write("owner")
    var parsed = try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: String]
    #expect(parsed == ["account": "owner", "name": "Owner", "email": "owner@example.org"])

    try file.write("someone-else")
    parsed = try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: String]
    #expect(parsed == ["account": "someone-else"])
}
