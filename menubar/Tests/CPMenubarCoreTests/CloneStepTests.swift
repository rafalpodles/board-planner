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

    // BP-399. Both arguments come from the server — repositoryUrl and the project's key travel in
    // the catalogue the app reads off the worker's socket — and both are spent on the operator's
    // own machine at their uid. Same class as BP-327, one package over.

    // `ext::` hands the URL to a program, and git 2.50 only refuses it because protocol.ext.allow
    // defaults to never. That default is the operator's to change, so the shape is refused here
    // rather than left resting on it. Measured: with the transport permitted, the program runs.
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

    // NSString.appendingPathComponent does not normalise "..", so the key decided where the
    // checkout landed — and ProjectSetup then writes that path into repos.json, which is the
    // allowlist deciding where the worker may run anything at all.
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

    // git reads an option-shaped positional as an option. The shape check above is the gate; this
    // is the second line, so a future caller that loosens the gate does not silently reopen it.
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

    // Measured on git 2.50.1, spawned the way the app spawns it. The operator's own ~/.gitconfig is
    // not an attacker's, but it is a lever an attacker can steer into: `url.*.insteadOf` rewrites a
    // perfectly ordinary https remote to git://, and core.gitProxy then names a program git runs.
    // A URL-shape check cannot see that rewrite — the string it inspects is a real https URL — so
    // the transport is closed on the command line as well.
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
    // core.gitProxy is the one key that cannot be won in the config: git keeps the FIRST value it
    // finds, so the operator's ~/.gitconfig outranks any -c override. The environment is the layer
    // that wins, and an empty value there means "no proxy" rather than "fall through".
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

    // ~/.gitconfig is deliberately NOT taken out of the picture, unlike the worker's delivery path:
    // this runs during onboarding, and dropping it would take the operator's credential helper and
    // any core.sshCommand deploy key with it, at the one moment a failure is hardest to diagnose.
    func testItLeavesTheOperatorsOwnConfigReadable() {
        XCTAssertNil(GitSafeEnvironment.apply(to: [:])["GIT_CONFIG_GLOBAL"])
    }
}
