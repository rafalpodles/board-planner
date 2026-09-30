import XCTest
@testable import CPMenubarCore

// Free function, not a method: CheckoutRemoval.RunGit is @Sendable, and an XCTestCase is not.
/// `appInheriting` spawns the way the app does, through `GitSafeEnvironment`, on top of what the
/// app inherited. Only for the checks under test: under its `GIT_CONFIG_NOSYSTEM=1`, Apple git
/// 2.54.0 failed this file's local-path `submodule add` ("You are on a branch yet to be born").
@Sendable private func fixtureGit(
    _ cwd: String, _ args: [String], appInheriting inherited: [String: String]? = nil
) -> (code: Int32, output: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = ["git"] + args
    task.currentDirectoryURL = URL(fileURLWithPath: cwd)
    let fixture = [
        "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
    ]
    task.environment = inherited.map { GitSafeEnvironment.apply(to: $0.merging(fixture) { _, mine in mine }) }
        ?? fixture
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = pipe
    try? task.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    return (task.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

/// BP-734. Real submodules in the layouts where the git-dir git reports carries no `/.git/modules/`
/// segment, driven through all three readers of `LinkedWorktreeCheck`. Measured on git 2.54.0: with
/// the superproject's `.git` a symlink, or made by `init --separate-git-dir`, both `--git-dir` and
/// `--git-common-dir` answer the resolved `…/realgit/modules/vendor`; in the legacy layout (a real
/// `.git` directory inside the submodule) both answer `.git`. `--show-superproject-working-tree`
/// named the superproject in all three.
///
/// Every submodule here is pushed and on a branch, so before the fix each one was a `.go`, an
/// `.allowed` and a `.reused` — not refused for some unrelated reason.
final class SubmoduleLayoutTests: XCTestCase {
    private enum Layout {
        case ordinary
        case symlinkedGitDir
        case separateGitDir
        case legacy
    }

    private var dir = ""

    override func setUp() {
        super.setUp()
        dir = NSTemporaryDirectory() + "bp734-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: dir)
        super.tearDown()
    }

    private func git(_ cwd: String, _ args: [String]) -> (code: Int32, output: String) {
        fixtureGit(cwd, args)
    }

    private func pushedRepository(_ name: String) -> String {
        let origin = dir + "/\(name)-origin.git"
        let seed = dir + "/\(name)-seed"
        _ = git(dir, ["init", "-q", "--bare", origin])
        _ = git(dir, ["init", "-q", "-b", "main", seed])
        FileManager.default.createFile(atPath: seed + "/a.txt", contents: Data("a\n".utf8))
        _ = git(seed, ["add", "-A"])
        _ = git(seed, ["commit", "-qm", "initial"])
        _ = git(seed, ["remote", "add", "origin", origin])
        _ = git(seed, ["push", "-q", "-u", "origin", "HEAD"])
        return origin
    }

    /// `-c protocol.file.allow=always` for the same reason `CheckoutRemovalWorktreeTests` gives: a
    /// direct, operator-initiated `submodule add` of a local path, not the recursive case git's
    /// default guards against.
    /// The superproject's first commit predates the submodule, on a branch named `before`.
    private func submodule(
        in layout: Layout, at relativePath: String = "vendor"
    ) throws -> (superproject: String, submodulePath: String) {
        let subOrigin = pushedRepository("sub")
        let superOrigin = dir + "/super-origin.git"
        let superproject = dir + "/super"
        let submodulePath = superproject + "/" + relativePath
        _ = git(dir, ["init", "-q", "--bare", superOrigin])

        if layout == .separateGitDir {
            _ = git(dir, ["init", "-q", "-b", "main", "--separate-git-dir", dir + "/super-gitdir", superproject])
        } else {
            _ = git(dir, ["init", "-q", "-b", "main", superproject])
        }

        _ = git(superproject, ["commit", "-q", "--allow-empty", "-m", "before the submodule"])
        _ = git(superproject, ["branch", "before"])

        if layout == .legacy {
            // `submodule add` of a path that already holds a clone keeps that clone's own `.git`
            // directory ("Adding existing repo at 'vendor' to the index") — the pre-1.7.8 shape
            _ = git(superproject, ["clone", "-q", subOrigin, relativePath])
        }
        _ = git(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subOrigin, relativePath])
        _ = git(superproject, ["commit", "-qm", "add submodule"])
        _ = git(superproject, ["remote", "add", "origin", superOrigin])
        _ = git(superproject, ["push", "-q", "-u", "origin", "HEAD"])
        // A detached HEAD fails CloneStep's `push --dry-run origin HEAD`, which would refuse the
        // submodule for a reason that has nothing to do with it being one
        _ = git(submodulePath, ["checkout", "-q", "main"])

        if layout == .symlinkedGitDir {
            try FileManager.default.moveItem(atPath: superproject + "/.git", toPath: superproject + "/realgit")
            try FileManager.default.createSymbolicLink(atPath: superproject + "/.git", withDestinationPath: "realgit")
            // git does not recognise the moved directory as its own, and lists it untracked
            try Data("/realgit/\n".utf8).write(to: URL(fileURLWithPath: superproject + "/realgit/info/exclude"))
        }

        // Without it a git that refused the add leaves `vendor` absent, and a spawn into a missing
        // cwd hangs `readDataToEndOfFile()` rather than failing (see CheckoutRemovalWorktreeTests)
        try XCTSkipIf(
            !FileManager.default.fileExists(atPath: submodulePath + "/a.txt"),
            "this git refused a file-protocol submodule")
        return (superproject, submodulePath)
    }

    private func assertTheFixtureIsTheLayoutItClaims(_ layout: Layout, _ submodulePath: String) {
        let gitDir = git(submodulePath, ["rev-parse", "--git-dir"]).output
        XCTAssertFalse(gitDir.contains("/.git/modules/"), "fixture is not the evading shape: \(gitDir)")
        if layout == .legacy {
            var isDirectory: ObjCBool = false
            FileManager.default.fileExists(atPath: submodulePath + "/.git", isDirectory: &isDirectory)
            XCTAssertTrue(isDirectory.boolValue, "a legacy submodule keeps a real .git directory")
        }
    }

    private func assertRemovalRefuses(_ layout: Layout, file: StaticString = #filePath, line: UInt = #line) throws {
        let (_, submodulePath) = try submodule(in: layout)
        assertTheFixtureIsTheLayoutItClaims(layout, submodulePath)

        let verdict = CheckoutRemoval(run: { args, cwd in fixtureGit(cwd, args) })
            .check(path: submodulePath, workerIsBusy: false)

        guard case .linkedWorktree(let reason) = verdict else {
            return XCTFail("expected the submodule to be left alone, got \(verdict)", file: file, line: line)
        }
        XCTAssertTrue(reason.contains("submodule"), reason, file: file, line: line)
    }

    private func assertGrantRefuses(_ layout: Layout, file: StaticString = #filePath, line: UInt = #line) throws {
        let (_, submodulePath) = try submodule(in: layout)
        assertTheFixtureIsTheLayoutItClaims(layout, submodulePath)

        let verdict = CheckoutGrant.check(path: submodulePath) { args, cwd in fixtureGit(cwd, args) }

        guard case .refused(let reason) = verdict else {
            return XCTFail("expected a refusal, got \(verdict)", file: file, line: line)
        }
        XCTAssertTrue(reason.contains("submodule"), reason, file: file, line: line)
    }

    private func assertCloneRefusesToAdopt(_ layout: Layout, file: StaticString = #filePath, line: UInt = #line) throws {
        let (superproject, submodulePath) = try submodule(in: layout)
        assertTheFixtureIsTheLayoutItClaims(layout, submodulePath)

        let outcome = CloneStep(run: { _, args, _ in fixtureGit(superproject, args) })
            .run(repositoryURL: "https://github.com/o/r", parent: superproject, projectKey: "vendor")

        guard case .failed(let reason) = outcome else {
            return XCTFail("expected a refusal to adopt, got \(outcome)", file: file, line: line)
        }
        XCTAssertTrue(reason.contains("submodule"), reason, file: file, line: line)
    }

    func testRemovalLeavesASubmoduleBehindASymlinkedSuperprojectGitAlone() throws {
        try assertRemovalRefuses(.symlinkedGitDir)
    }

    func testRemovalLeavesASubmoduleOfASeparateGitDirSuperprojectAlone() throws {
        try assertRemovalRefuses(.separateGitDir)
    }

    func testRemovalLeavesALegacySubmoduleAlone() throws {
        try assertRemovalRefuses(.legacy)
    }

    func testGrantRefusesASubmoduleBehindASymlinkedSuperprojectGit() throws {
        try assertGrantRefuses(.symlinkedGitDir)
    }

    func testGrantRefusesASubmoduleOfASeparateGitDirSuperproject() throws {
        try assertGrantRefuses(.separateGitDir)
    }

    func testGrantRefusesALegacySubmodule() throws {
        try assertGrantRefuses(.legacy)
    }

    func testCloneRefusesToAdoptASubmoduleBehindASymlinkedSuperprojectGit() throws {
        try assertCloneRefusesToAdopt(.symlinkedGitDir)
    }

    func testCloneRefusesToAdoptASubmoduleOfASeparateGitDirSuperproject() throws {
        try assertCloneRefusesToAdopt(.separateGitDir)
    }

    func testCloneRefusesToAdoptALegacySubmodule() throws {
        try assertCloneRefusesToAdopt(.legacy)
    }

    // MARK: - BP-734 review: an empty superproject answer is also "could not read it"

    /// `--show-superproject-working-tree` looks for a gitlink in the parent's index, and answers
    /// empty with exit 0 when there is none. Checking the superproject out to a branch that
    /// predates the submodule leaves `vendor/` behind (git: "unable to rmdir 'vendor'") with its
    /// `.git` file still pointing into `.git/modules/`, and no gitlink for it anywhere — measured.
    /// Trusting the empty answer alone made it a `.go` and an `.allowed`.
    func testASubmoduleLeftBehindByABranchThatPredatesItIsStillLeftAlone() throws {
        let (superproject, submodulePath) = try submodule(in: .ordinary)
        _ = git(superproject, ["checkout", "-q", "before"])
        XCTAssertEqual(
            git(submodulePath, ["rev-parse", "--show-superproject-working-tree"]).output
                .trimmingCharacters(in: .whitespacesAndNewlines),
            "", "the premise: git no longer names a superproject")

        guard case .linkedWorktree(let reason) = CheckoutRemoval(run: { args, cwd in fixtureGit(cwd, args) })
            .check(path: submodulePath, workerIsBusy: false)
        else { return XCTFail("the leftover submodule was offered for removal") }
        XCTAssertTrue(reason.contains("submodule"), reason)
        guard case .refused = CheckoutGrant.check(path: submodulePath, run: { args, cwd in fixtureGit(cwd, args) })
        else { return XCTFail("the leftover submodule was granted") }
    }

    /// `GIT_CEILING_DIRECTORIES` naming the superproject stops the lookup one level up from
    /// `libs/deep`, and the answer is empty, exit 0 — measured. With a symlinked superproject `.git`
    /// the git-dir has no `/.git/modules/` either, so nothing else would catch it: the variable has
    /// to be kept from reaching git at all, through the same `GitSafeEnvironment` every app spawn
    /// uses.
    func testAnInheritedCeilingDoesNotHideTheSuperproject() throws {
        let (superproject, submodulePath) = try submodule(in: .symlinkedGitDir, at: "libs/deep")
        let inherited = ["GIT_CEILING_DIRECTORIES": superproject]

        guard case .linkedWorktree = CheckoutRemoval(run: { args, cwd in fixtureGit(cwd, args, appInheriting: inherited) })
            .check(path: submodulePath, workerIsBusy: false)
        else { return XCTFail("a ceiling in the environment made the submodule removable") }
    }

    /// The controls: the layout BP-507 already caught still is, through all three readers.
    func testAnOrdinarySubmoduleIsStillLeftAloneEverywhere() throws {
        let (superproject, submodulePath) = try submodule(in: .ordinary)

        guard case .linkedWorktree = CheckoutRemoval(run: { args, cwd in fixtureGit(cwd, args) })
            .check(path: submodulePath, workerIsBusy: false)
        else { return XCTFail("removal") }
        guard case .refused = CheckoutGrant.check(path: submodulePath, run: { args, cwd in fixtureGit(cwd, args) })
        else { return XCTFail("grant") }
        guard case .failed(let reason) = CloneStep(run: { _, args, _ in fixtureGit(superproject, args) })
            .run(repositoryURL: "https://github.com/o/r", parent: superproject, projectKey: "vendor")
        else { return XCTFail("clone") }
        XCTAssertTrue(reason.contains("submodule"), reason)
    }

    /// And the superproject itself — which `--show-superproject-working-tree` answers empty for — is
    /// still an ordinary repository in every layout, so the new question refuses nothing it should not.
    func testTheSuperprojectItselfIsStillARepositoryInEveryLayout() throws {
        for layout in [Layout.ordinary, .symlinkedGitDir, .separateGitDir, .legacy] {
            tearDown()
            setUp()
            let (superproject, _) = try submodule(in: layout)
            XCTAssertEqual(
                CheckoutGrant.check(path: superproject) { args, cwd in fixtureGit(cwd, args) }, .allowed,
                "\(layout)")
            let verdict = CheckoutRemoval(run: { args, cwd in fixtureGit(cwd, args) })
                .check(path: superproject, workerIsBusy: false)
            guard case .go(let root, let worktrees) = verdict else {
                XCTFail("\(layout): \(verdict)")
                continue
            }
            XCTAssertTrue(root.hasSuffix("/super"), "\(layout): \(root)")
            XCTAssertEqual(worktrees, [], "\(layout)")
        }
    }

    /// A submodule inside a submodule names the outer one as its superproject, so it is still
    /// refused once the decision no longer rests on the `modules/` segment nesting.
    func testANestedSubmoduleIsStillLeftAlone() throws {
        let (superproject, _) = try submodule(in: .ordinary)
        let innerOrigin = pushedRepository("inner")
        let outer = superproject + "/vendor"
        _ = git(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", innerOrigin, "inner"])
        let inner = outer + "/inner"
        try XCTSkipIf(!FileManager.default.fileExists(atPath: inner + "/a.txt"), "this git refused a nested submodule")

        guard case .linkedWorktree(let reason) = CheckoutRemoval(run: { args, cwd in fixtureGit(cwd, args) })
            .check(path: inner, workerIsBusy: false)
        else { return XCTFail("a nested submodule was offered for removal") }
        XCTAssertTrue(reason.contains("submodule"), reason)
    }
}
