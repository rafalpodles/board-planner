import XCTest
@testable import CPMenubarCore

final class RepositoryCheckTests: XCTestCase {
    private func good(
        resolved: String = "/Users/owner/checkout",
        hasGit: Bool = false,
        permissions: Int = 0o755,
        owned: Bool = true
    ) -> RepositoryInspection {
        RepositoryInspection(
            exists: true, isDirectory: true, resolved: resolved,
            hasGitDirectory: hasGit, posixPermissions: permissions, ownedByCurrentUser: owned)
    }

    func testAPlainFolderHasNothingToSay() {
        XCTAssertTrue(RepositoryCheck.problems(at: "/Users/owner/checkout", good()).isEmpty)
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
            at: "/Users/owner/link", good(resolved: "/Volumes/work/checkout"))

        XCTAssertEqual(problems.count, 1)
        XCTAssertTrue(problems[0].summary.contains("/Volumes/work/checkout"))
        XCTAssertTrue(problems[0].fix.contains("/Volumes/work/checkout"), "the fix should be the path to pick")
    }

    // The pick this whole design exists to prevent. The worker gets its own clone rather than
    // working inside the operator's — it registers worktrees in whatever it is handed and reaps
    // directories beside them, which has already bitten in this repository.
    func testPickingAnActualCheckoutIsRefusedWithTheReason() {
        let problems = RepositoryCheck.problems(at: "/Users/owner/checkout", good(hasGit: true))

        XCTAssertEqual(problems.count, 1)
        XCTAssertTrue(problems[0].summary.contains("itself a checkout"))
        XCTAssertTrue(problems[0].fix.contains("clones its own copy"))
    }

    func testAGroupWritableCheckoutIsRefused() {
        XCTAssertEqual(RepositoryCheck.problems(at: "/Users/owner/checkout", good(permissions: 0o775)).count, 1)
    }

    func testAWorldWritableCheckoutIsRefused() {
        XCTAssertEqual(RepositoryCheck.problems(at: "/Users/owner/checkout", good(permissions: 0o757)).count, 1)
    }

    func testSomeoneElsesCheckoutIsRefused() {
        let problems = RepositoryCheck.problems(
            at: "/Users/other/checkout", good(resolved: "/Users/other/checkout", owned: false))

        XCTAssertEqual(problems.count, 1)
        XCTAssertTrue(problems[0].summary.contains("belongs to someone else"))
    }

    func testEveryProblemCarriesSomethingToDoAboutIt() {
        let problems = RepositoryCheck.problems(
            at: "/Users/owner/link", good(resolved: "/elsewhere", hasGit: true, permissions: 0o777, owned: false))

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

        let empty = RepositoryCheck.inspect(directory.path)
        XCTAssertTrue(empty.exists)
        XCTAssertTrue(empty.isDirectory)
        XCTAssertTrue(empty.ownedByCurrentUser)
        XCTAssertFalse(empty.hasGitDirectory)
        XCTAssertTrue(
            RepositoryCheck.problems(at: directory.path, empty).isEmpty,
            "an ordinary empty folder is exactly what this asks for")

        // …and the same folder becomes a refusal the moment it is a checkout
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent(".git"), withIntermediateDirectories: true)
        let asCheckout = RepositoryCheck.inspect(directory.path)
        XCTAssertTrue(asCheckout.hasGitDirectory)
        XCTAssertEqual(RepositoryCheck.problems(at: directory.path, asCheckout).count, 1)
    }
}
