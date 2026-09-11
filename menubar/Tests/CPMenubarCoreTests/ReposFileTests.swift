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
    try file.write(["/Users/owner/code/a", "/Users/owner/code/b"])

    #expect(try file.read() == ["/Users/owner/code/a", "/Users/owner/code/b"])
}

// repos.ts reads {"repos": [...]}; any other shape means every binding is silently refused.
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

// MARK: - BP-600: a held file follows the state directory

/// The bug this initialiser exists for. `ProjectSyncRunner` is a singleton holding its allowlist in
/// a `let`, and the screen offering the state-directory chooser is the screen that initialises it —
/// so after a switch the app granted and dropped checkouts in the file the *old* directory holds,
/// while cloning into the new one and reporting on screen that both had worked. Nothing visible
/// said otherwise; the tell was a worker ignoring a project the app said it had set up.
@Test func aHeldAllowlistFollowsTheStateDirectory() throws {
    let root = NSTemporaryDirectory() + "bp600-" + UUID().uuidString
    let first = root + "/first"
    let second = root + "/second"
    let directory = MovingDirectory(first)
    defer { try? FileManager.default.removeItem(atPath: root) }

    // Held once, exactly as the runner holds it, and never rebuilt.
    let file = ReposFile(inStateDirectory: { directory.value })

    try file.write(["/checkouts/one"])
    directory.value = second
    try file.write(["/checkouts/two"])

    #expect(try ReposFile(path: ReposFile.path(in: first)).read() == ["/checkouts/one"])
    #expect(
        try ReposFile(path: ReposFile.path(in: second)).read() == ["/checkouts/two"],
        "the second write lands where the worker now reads, not where it used to")
    #expect(try file.read() == ["/checkouts/two"], "and reading follows the same way writing does")
}

/// The control. A file given a path is a file at that path — the fixed initialiser must not start
/// chasing the state directory, because Preferences uses it to show a named location.
@Test func aFileGivenAPathStaysThere() throws {
    let root = NSTemporaryDirectory() + "bp600-fixed-" + UUID().uuidString
    defer { try? FileManager.default.removeItem(atPath: root) }
    let file = ReposFile(path: ReposFile.path(in: root))

    try file.write(["/checkouts/one"])
    StateDirectory.set("/somewhere/else", defaults: UserDefaults(suiteName: "bp600-\(UUID().uuidString)")!)

    #expect(try file.read() == ["/checkouts/one"])
}

/// The operator pointing the app somewhere else, in the only form a `@Sendable` closure can read.
private final class MovingDirectory: @unchecked Sendable {
    var value: String
    init(_ value: String) { self.value = value }
}
