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
                    if args.contains("--git-dir") || args.contains("--git-common-dir") {
                        return (0, ".git")
                    }
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
        XCTAssertEqual(
            git.calls.first,
            [
                "git", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never",
                "clone", "--", "https://github.com/o/r", "/Users/rpo/checkouts/TP",
            ])
    }

    func testTheDestinationIsTheProjectKey() {
        XCTAssertEqual(CloneStep.destination(parent: "/a", projectKey: "TP"), "/a/TP")
    }

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

    func testAnExistingCloneIsReusedAndRefreshed() {
        let git = Git()
        git.present = ["/p/TP/.git"]

        let outcome = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        XCTAssertEqual(outcome, .reused(path: "/p/TP"))
        XCTAssertTrue(git.calls.contains { $0.contains("fetch") })
        XCTAssertFalse(git.calls.contains { $0.contains("clone") }, "cloning over an existing one would be destructive")
    }

    func testItRefusesToAdoptALinkedWorktree() {
        let git = Git()
        git.present = ["/p/TP/.git"]
        git.results["--git-dir"] = (0, "/elsewhere/repo/.git/worktrees/TP")
        git.results["--git-common-dir"] = (0, "/elsewhere/repo/.git")

        let outcome = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        guard case .failed(let reason) = outcome else {
            return XCTFail("expected a refusal, got \(outcome)")
        }
        XCTAssertTrue(reason.contains("worktree"), "the refusal has to say what it found: \(reason)")
        XCTAssertFalse(git.calls.contains { $0.contains("fetch") }, "and it refuses before touching the network")
    }

    func testItRefusesToAdoptADirectoryGitWillNotDescribe() {
        let git = Git()
        git.present = ["/p/TP/.git"]
        git.results["--git-common-dir"] = (128, "not a git repository")

        guard case .failed(let reason) = git.step().run(
            repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")
        else { return XCTFail("expected a refusal") }
        XCTAssertTrue(reason.contains("could not say"), reason)
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

    func testItRefusesARemoteWhoseTransportRunsAProgram() {
        for url in ["ext::sh -c touch /tmp/pwned", "git://evil.invalid/x", "file:///tmp/x", "/tmp/local/repo"] {
            let git = Git()

            let outcome = git.step().run(repositoryURL: url, parent: "/p", projectKey: "TP")

            guard case .failed(let reason) = outcome else {
                return XCTFail("expected \(url) to be refused, got \(outcome)")
            }
            XCTAssertTrue(reason.contains("remote"), "the reason should name the remote: \(reason)")
            XCTAssertTrue(git.calls.isEmpty, "git must not be run at all for \(url)")
        }
    }

    func testItRefusesAnOptionShapedRemote() {
        let git = Git()

        let outcome = git.step().run(
            repositoryURL: "--upload-pack=touch /tmp/pwned", parent: "/p", projectKey: "TP")

        guard case .failed = outcome else { return XCTFail("expected a refusal, got \(outcome)") }
        XCTAssertTrue(git.calls.isEmpty)
    }

    func testItAcceptsTheRemotesPeopleActuallyHave() {
        for url in [
            "https://github.com/o/r",
            "https://github.com/o/r.git",
            "http://gitlab.internal:8080/o/r.git",
            "ssh://git@github.com/o/r.git",
            "git@github.com:o/r.git",
        ] {
            let git = Git()

            let outcome = git.step().run(repositoryURL: url, parent: "/p", projectKey: "TP")

            XCTAssertEqual(outcome, .cloned(path: "/p/TP"), "\(url) should be accepted")
        }
    }

    func testItRefusesAProjectKeyThatIsNotASingleDirectoryName() {
        for key in ["../../../../Users/rpo/Library/LaunchAgents", "..", "a/b", ".hidden", "", "-x"] {
            let git = Git()

            let outcome = git.step().run(
                repositoryURL: "https://github.com/o/r", parent: "/Users/rpo/checkouts", projectKey: key)

            guard case .failed(let reason) = outcome else {
                return XCTFail("expected key \(key) to be refused, got \(outcome)")
            }
            XCTAssertTrue(reason.contains("project key"), "the reason should name the key: \(reason)")
            XCTAssertTrue(git.calls.isEmpty, "git must not be run at all for key \(key)")
        }
    }

    func testItAcceptsTheKeysABoardActuallyHas() {
        for key in ["BP", "TP", "board-planner", "my_project", "6a8ae66089f53f7bc3e7f9d6"] {
            let git = Git()

            let outcome = git.step().run(
                repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: key)

            XCTAssertEqual(outcome, .cloned(path: "/p/\(key)"), "\(key) should be accepted")
        }
    }

    func testItSeparatesTheCloneArgumentsFromGitsOptions() {
        let git = Git()

        _ = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        guard let clone = git.calls.first(where: { $0.contains("clone") }) else {
            return XCTFail("expected a clone call")
        }
        guard let separator = clone.firstIndex(of: "--"),
            let url = clone.firstIndex(of: "https://github.com/o/r"),
            let target = clone.firstIndex(of: "/p/TP")
        else { return XCTFail("expected a -- separator before both positionals: \(clone)") }
        XCTAssertLessThan(separator, url)
        XCTAssertLessThan(separator, target)
    }

    func testItRefusesTheTransportsThatRunAProgram() {
        let git = Git()

        _ = git.step().run(repositoryURL: "https://github.com/o/r", parent: "/p", projectKey: "TP")

        guard let clone = git.calls.first(where: { $0.contains("clone") }) else {
            return XCTFail("expected a clone call")
        }
        XCTAssertTrue(clone.contains("protocol.ext.allow=never"), "ext:: hands the URL to a program")
        XCTAssertTrue(
            clone.contains("protocol.file.allow=never"),
            "a local clone runs git-upload-pack against the source")
        guard let firstConfig = clone.firstIndex(of: "-c"), let subcommand = clone.firstIndex(of: "clone")
        else { return XCTFail("expected -c before the subcommand: \(clone)") }
        XCTAssertLessThan(firstConfig, subcommand, "-c is a git option, not a clone option")
    }
}

final class GitSafeEnvironmentTests: XCTestCase {
    func testItEmptiesTheProxyCommandRatherThanLeavingItToTheConfig() {
        let hardened = GitSafeEnvironment.apply(to: ["PATH": "/usr/bin"])

        XCTAssertEqual(hardened["GIT_PROXY_COMMAND"], "")
        XCTAssertEqual(hardened["GIT_CONFIG_NOSYSTEM"], "1")
    }

    func testItKeepsWhatTheCallerAlreadySet() {
        let hardened = GitSafeEnvironment.apply(to: ["PATH": "/opt/homebrew/bin", "GH_TOKEN": "gho_x"])

        XCTAssertEqual(hardened["PATH"], "/opt/homebrew/bin", "the resolved PATH is the whole point of it")
        XCTAssertEqual(hardened["GH_TOKEN"], "gho_x")
    }

    func testItDoesNotInheritTheVariablesThatPointGitAtAnotherRepository() {
        let hardened = GitSafeEnvironment.apply(to: [
            "PATH": "/usr/bin",
            "GIT_DIR": "/elsewhere/.git",
            "GIT_COMMON_DIR": "/elsewhere/.git",
            "GIT_WORK_TREE": "/elsewhere",
            "GIT_INDEX_FILE": "/elsewhere/.git/index",
        ])

        XCTAssertNil(hardened["GIT_DIR"])
        XCTAssertNil(hardened["GIT_COMMON_DIR"])
        XCTAssertNil(hardened["GIT_WORK_TREE"])
        XCTAssertNil(hardened["GIT_INDEX_FILE"])
        XCTAssertFalse(hardened.keys.contains("GIT_DIR"))
        XCTAssertEqual(hardened["PATH"], "/usr/bin", "the control — hardening is not a wipe")
    }

    func testItLeavesTheOperatorsOwnConfigReadable() {
        XCTAssertNil(GitSafeEnvironment.apply(to: [:])["GIT_CONFIG_GLOBAL"])
    }
}
