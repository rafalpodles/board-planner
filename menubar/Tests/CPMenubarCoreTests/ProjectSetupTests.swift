import XCTest
@testable import CPMenubarCore

final class ProjectSetupTests: XCTestCase {
    private final class Git: @unchecked Sendable {
        var calls: [[String]] = []
        var results: [String: (Int32, String)] = [:]
        var present: Set<String> = []

        func step() -> CloneStep {
            CloneStep(
                run: { tool, args, _ in
                    self.calls.append([tool] + args)
                    for (needle, result) in self.results where args.contains(needle) { return result }
                    // An ordinary checkout answers both of these with the same relative `.git`.
                    // Without it every stub would look like a directory git cannot describe, which
                    // CloneStep now refuses to adopt (BP-422)
                    if args.contains("--git-dir") || args.contains("--git-common-dir") {
                        return (0, ".git")
                    }
                    return (0, "")
                },
                exists: { self.present.contains($0) })
        }
    }

    private func scratchRepos() throws -> ReposFile {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return ReposFile(path: dir.appendingPathComponent("repos.json").path)
    }

    private let sandbox = ProjectOffer(
        project: "p2", key: "SB", name: "Sandbox",
        repositoryUrl: "https://github.com/rafalpodles/ventures")

    func testItClonesTheProjectAndGrantsTheCheckout() throws {
        let git = Git()
        let repos = try scratchRepos()

        let result = ProjectSetup(clone: git.step(), repos: repos).add(sandbox, parent: "/checkouts")

        XCTAssertEqual(try result.get(), "/checkouts/SB")
        XCTAssertEqual(try repos.read(), ["/checkouts/SB"])
        XCTAssertEqual(
            git.calls.first,
            [
                "git", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never",
                "clone", "--", "https://github.com/rafalpodles/ventures", "/checkouts/SB",
            ])
    }

    // repos.json is the grant, so writing one for a checkout that was refused would produce a
    // machine the board believes can work and which cannot.
    func testItGrantsNothingWhenTheCloneIsRefused() throws {
        let git = Git()
        git.results["clone"] = (128, "Repository not found.")
        let repos = try scratchRepos()

        let result = ProjectSetup(clone: git.step(), repos: repos).add(sandbox, parent: "/checkouts")

        guard case .failure(.clone(let reason)) = result else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("Repository not found"))
        XCTAssertEqual(try repos.read(), [])
    }

    // The same rule onboarding applies: read-only access is fatal, and it is worth finding out here
    // rather than after an agent has worked and six gates have passed.
    func testItGrantsNothingWhenTheCheckoutCannotBePushedTo() throws {
        let git = Git()
        git.results["push"] = (128, "remote: Write access to repository not granted.")
        let repos = try scratchRepos()

        let result = ProjectSetup(clone: git.step(), repos: repos).add(sandbox, parent: "/checkouts")

        guard case .failure(.clone) = result else { return XCTFail("expected a refusal") }
        XCTAssertEqual(try repos.read(), [])
    }

    // Re-adding a project whose checkout is already there must not fail on its own earlier success
    func testItReusesACheckoutThatIsAlreadyThere() throws {
        let git = Git()
        git.present = ["/checkouts/SB/.git"]
        let repos = try scratchRepos()
        try repos.write(["/checkouts/SB"])

        let result = ProjectSetup(clone: git.step(), repos: repos).add(sandbox, parent: "/checkouts")

        XCTAssertEqual(try result.get(), "/checkouts/SB")
        XCTAssertEqual(try repos.read(), ["/checkouts/SB"], "the grant must not be duplicated")
        XCTAssertFalse(git.calls.contains { $0.contains("clone") })
    }

    // An offer with no key still has to land somewhere nameable. The project id is not pretty, but
    // it is unique, and a directory named after nothing is worse.
    func testItNamesTheCheckoutAfterTheProjectWhenThereIsNoKey() throws {
        let git = Git()
        let repos = try scratchRepos()
        let keyless = ProjectOffer(
            project: "p9", key: "", name: "Keyless", repositoryUrl: "https://github.com/o/r")

        let result = ProjectSetup(clone: git.step(), repos: repos).add(keyless, parent: "/checkouts")

        XCTAssertEqual(try result.get(), "/checkouts/p9")
    }

    // The existing grants belong to other projects and this machine is still serving them
    func testItKeepsTheCheckoutsItAlreadyHad() throws {
        let git = Git()
        let repos = try scratchRepos()
        try repos.write(["/checkouts/BP"])

        _ = ProjectSetup(clone: git.step(), repos: repos).add(sandbox, parent: "/checkouts")

        XCTAssertEqual(try repos.read(), ["/checkouts/BP", "/checkouts/SB"])
    }
}
