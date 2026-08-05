import XCTest
@testable import CPMenubarCore

final class CloneStepTests: XCTestCase {
    private final class Git: @unchecked Sendable {
        var calls: [[String]] = []
        var results: [String: (Int32, String)] = [:]
        var present: Set<String> = []

        func step() -> CloneStep {
            CloneStep(
                run: { tool, args, _ in
                    self.calls.append([tool] + args)
                    for (needle, result) in self.results where args.contains(needle) { return result }
                    return (0, "")
                },
                exists: { self.present.contains($0) })
        }
    }

    func testItClonesIntoTheFolderUnderTheProjectKey() {
        let git = Git()

        let outcome = git.step().run(
            repositoryURL: "https://github.com/o/r", parent: "/Users/rpo/checkouts", projectKey: "TP")

        XCTAssertEqual(outcome, .cloned(path: "/Users/rpo/checkouts/TP"))
        XCTAssertEqual(git.calls.first, ["git", "clone", "https://github.com/o/r", "/Users/rpo/checkouts/TP"])
    }

    // Keyed on the project rather than the repository, so two projects sharing one repository get
    // two clones. Accepted deliberately — worth being explicit rather than discovering it.
    func testTheDestinationIsTheProjectKey() {
        XCTAssertEqual(CloneStep.destination(parent: "/a", projectKey: "TP"), "/a/TP")
    }

    // The worker pushes to origin with --force-with-lease and has no notion of a fork, so read-only
    // access is fatal. Today it fails after the agent has worked and six gates have passed, which
    // is the worst possible moment to find out.
    func testItRefusesACloneItCannotPushTo() {
        let git = Git()
        git.results["push"] = (128, "remote: Write access to repository not granted.")

        let outcome = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        guard case .failed(let reason) = outcome else { return XCTFail("expected a refusal, got \(outcome)") }
        XCTAssertTrue(reason.contains("cannot push"))
        XCTAssertTrue(reason.contains("Write access"), "the reason git gave should survive")
    }

    func testItProbesPushWithoutActuallyPushing() {
        let git = Git()

        _ = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        let push = git.calls.first { $0.contains("push") }
        XCTAssertNotNil(push)
        XCTAssertTrue(push!.contains("--dry-run"), "the check must not write to anyone's repository")
    }

    // Re-entering the step must not fail on its own earlier success — the whole flow is resumable
    func testAnExistingCloneIsReusedAndRefreshed() {
        let git = Git()
        git.present = ["/p/TP/.git"]

        let outcome = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        XCTAssertEqual(outcome, .reused(path: "/p/TP"))
        XCTAssertTrue(git.calls.contains { $0.contains("fetch") })
        XCTAssertFalse(git.calls.contains { $0.contains("clone") }, "cloning over an existing one would be destructive")
    }

    func testSomethingElseAlreadyAtTheDestinationIsNotClobbered() {
        let git = Git()
        git.present = ["/p/TP"]

        let outcome = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        guard case .failed(let reason) = outcome else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("already exists"))
        XCTAssertFalse(git.calls.contains { $0.contains("clone") })
    }

    func testAFailedCloneSaysWhatGitSaid() {
        let git = Git()
        git.results["clone"] = (128, "fatal: repository not found")

        let outcome = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        guard case .failed(let reason) = outcome else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("repository not found"))
    }
}
