import XCTest
@testable import CPMenubarCore

final class RepositoryCheckTests: XCTestCase {
    private func good(
        resolved: String = "/Users/rpo/checkout",
        hasGit: Bool = true,
        permissions: Int = 0o755,
        owned: Bool = true
    ) -> RepositoryInspection {
        RepositoryInspection(
            exists: true, isDirectory: true, resolved: resolved,
            hasGitDirectory: hasGit, posixPermissions: permissions, ownedByCurrentUser: owned)
    }

    func testAGoodCheckoutHasNothingToSay() {
        XCTAssertTrue(RepositoryCheck.problems(at: "/Users/rpo/checkout", good()).isEmpty)
    }

    func testAMissingFolderIsTheOnlyThingReported() {
        let problems = RepositoryCheck.problems(
            at: "/nope",
            RepositoryInspection(
                exists: false, isDirectory: false, resolved: "/nope",
                hasGitDirectory: false, posixPermissions: 0, ownedByCurrentUser: true))

        XCTAssertEqual(problems.count, 1, "no point listing what is wrong with a folder that is not there")
        XCTAssertTrue(problems[0].summary.contains("no folder"))
    }

    // The worker compares real paths, so a symlinked pick is not the directory it ends up in
    func testASymlinkIsNamedAlongWithWhatItPointsAt() {
        let problems = RepositoryCheck.problems(
            at: "/Users/rpo/link", good(resolved: "/Volumes/work/checkout"))

        XCTAssertEqual(problems.count, 1)
        XCTAssertTrue(problems[0].summary.contains("/Volumes/work/checkout"))
        XCTAssertTrue(problems[0].fix.contains("/Volumes/work/checkout"), "the fix should be the path to pick")
    }

    // A package inside a monorepo is the most plausible wrong pick of all
    func testAFolderWithNoGitIsRefusedWithTheReason() {
        let problems = RepositoryCheck.problems(at: "/Users/rpo/checkout", good(hasGit: false))

        XCTAssertEqual(problems.count, 1)
        XCTAssertTrue(problems[0].summary.contains("not the top of a git repository"))
        XCTAssertTrue(problems[0].fix.contains(".git"))
    }

    func testAGroupWritableCheckoutIsRefused() {
        XCTAssertEqual(RepositoryCheck.problems(at: "/Users/rpo/checkout", good(permissions: 0o775)).count, 1)
    }

    func testAWorldWritableCheckoutIsRefused() {
        XCTAssertEqual(RepositoryCheck.problems(at: "/Users/rpo/checkout", good(permissions: 0o757)).count, 1)
    }

    func testSomeoneElsesCheckoutIsRefused() {
        let problems = RepositoryCheck.problems(
            at: "/Users/other/checkout", good(resolved: "/Users/other/checkout", owned: false))

        XCTAssertEqual(problems.count, 1)
        XCTAssertTrue(problems[0].summary.contains("belongs to someone else"))
    }

    func testEveryProblemCarriesSomethingToDoAboutIt() {
        let problems = RepositoryCheck.problems(
            at: "/Users/rpo/link", good(resolved: "/elsewhere", hasGit: false, permissions: 0o777, owned: false))

        XCTAssertEqual(problems.count, 4, "all of them, not just the first")
        for problem in problems {
            XCTAssertFalse(problem.fix.isEmpty, "a refusal without a fix is where this went wrong before")
        }
    }

    // Against the real filesystem, so the inspection itself is not only a fixture
    func testItInspectsARealDirectory() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cp-check-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let withoutGit = RepositoryCheck.inspect(directory.path)
        XCTAssertTrue(withoutGit.exists)
        XCTAssertTrue(withoutGit.isDirectory)
        XCTAssertTrue(withoutGit.ownedByCurrentUser)
        XCTAssertFalse(withoutGit.hasGitDirectory)

        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent(".git"), withIntermediateDirectories: true)
        XCTAssertTrue(RepositoryCheck.inspect(directory.path).hasGitDirectory)
        XCTAssertTrue(RepositoryCheck.problems(at: directory.path, RepositoryCheck.inspect(directory.path)).isEmpty)
    }
}
