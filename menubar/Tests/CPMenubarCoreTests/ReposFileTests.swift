import Foundation
import Testing
@testable import CPMenubarCore

private func scratch() throws -> String {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("repos.json").path
}

@Test func readsAnEmptyListWhenTheFileDoesNotExist() throws {
    #expect(try ReposFile(path: scratch()).read() == [])
}

@Test func roundTripsTheWorkersOwnFormat() throws {
    let file = ReposFile(path: try scratch())
    try file.write(["/Users/rpo/code/a", "/Users/rpo/code/b"])

    #expect(try file.read() == ["/Users/rpo/code/a", "/Users/rpo/code/b"])
}

@Test func writesTheExactJsonShapeReposTsExpects() throws {
    let path = try scratch()
    try ReposFile(path: path).write(["/tmp/x"])

    let parsed = try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: [String]]

    #expect(parsed?["repos"] == ["/tmp/x"])
}

@Test func writesAtOwnerOnlyPermissions() throws {
    let path = try scratch()
    try ReposFile(path: path).write(["/tmp/x"])

    let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber

    #expect(mode?.int16Value == 0o600)
}

@Test func keepsOwnerOnlyPermissionsWhenOverwritingAnExistingFile() throws {
    let path = try scratch()
    let file = ReposFile(path: path)
    try file.write(["/tmp/x"])
    try file.write(["/tmp/x", "/tmp/y"])

    let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber

    #expect(mode?.int16Value == 0o600)
    #expect(try file.read() == ["/tmp/x", "/tmp/y"])
}

@Test func refusesARelativePathRatherThanWritingOneTheWorkerWillReject() throws {
    let file = ReposFile(path: try scratch())

    #expect(throws: ReposError.notAbsolute) { try file.write(["relative/path"]) }
}

@Test func writesNothingAtAllWhenOnePathInTheBatchIsRejected() throws {
    let path = try scratch()
    let file = ReposFile(path: path)
    try file.write(["/tmp/good"])

    #expect(throws: (any Error).self) { try file.write(["/tmp/good", "also-relative"]) }
    #expect(try file.read() == ["/tmp/good"])
}

@Test func theAllowlistDefaultsToTheWorkersOwnStateDirectory() {
    #expect(ReposFile.defaultPath().hasSuffix("/repos.json"))
}
