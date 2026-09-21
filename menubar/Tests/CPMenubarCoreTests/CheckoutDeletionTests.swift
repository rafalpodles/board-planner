import XCTest
@testable import CPMenubarCore

private struct Boom: Error, LocalizedError {
    let path: String
    var errorDescription: String? { "could not remove \(path)" }
}

/// Real git, for the one test in this file that needs its actual symlink resolution rather than a
/// mocked answer — `CheckoutRemovalReachTests.swift` has its own copy for the same reason.
@Sendable private func reachGitForDeletionTests(_ cwd: String, _ args: [String]) -> (code: Int32, output: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = ["git"] + args
    task.currentDirectoryURL = URL(fileURLWithPath: cwd)
    task.environment = [
        "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
    ]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = pipe
    do {
        try task.run()
    } catch {
        return (127, "could not run git: \(error.localizedDescription)")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    return (task.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

// @MainActor for `removeIfSafe`, which is isolated to it because asking the operator is a modal.
// `perform` is not, and the tests above it would compile either way.
@MainActor
final class CheckoutDeletionTests: XCTestCase {
    /// Captures what was asked of the disk, in order, so the sequence can be asserted rather than
    /// described. The order is the whole point: the grant is what lets the worker touch the
    /// directory, so dropping it before the delete succeeds strands a directory nothing may clean.
    private final class Recorder: @unchecked Sendable {
        var removed: [String] = []
        var forgotten: [String] = []
        var failOn: String?
        var failForget = false

        func remove(_ path: String) throws {
            if path == failOn { throw Boom(path: path) }
            removed.append(path)
        }

        func forget(_ path: String) throws {
            if failForget { throw Boom(path: path) }
            forgotten.append(path)
        }
    }

    private func deletion(
        _ r: Recorder,
        exists: @escaping @Sendable (String) -> Bool = { _ in true },
        isSymlink: @escaping @Sendable (String) -> Bool = { _ in false }
    ) -> CheckoutDeletion {
        CheckoutDeletion(
            remove: { try r.remove($0) }, exists: exists, forget: { try r.forget($0) },
            isSymlink: isSymlink)
    }

    func testItTakesTheWorktreesFirst_thenTheCheckout_thenTheGrant() {
        let r = Recorder()

        let step = deletion(r).perform(
            project: "BP", path: "/co", root: "/co", worktrees: ["/wt/one", "/wt/two"])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/wt/two", "/co"], "worktrees before the checkout")
        XCTAssertEqual(r.forgotten, ["/co"], "the grant goes last, and only on success")
    }

    /// The bug this file exists for. `try?` used to swallow this, leaving no step and letting the
    /// run report `.removed` for a checkout whose worktrees were still there.
    func testAWorktreeThatWillNotDeleteFailsTheWholeRemoval() {
        let r = Recorder()
        r.failOn = "/wt/two"

        let step = deletion(r).perform(
            project: "BP", path: "/co", root: "/co", worktrees: ["/wt/one", "/wt/two", "/wt/three"])

        // Partial, not failed: /wt/one is gone and saying only "/wt/two could not be removed"
        // reads as nothing having happened (BP-427).
        guard case .partiallyRemoved(let project, let removed, let reason) = step else {
            XCTFail("expected a partial removal, got \(step)")
            return
        }
        XCTAssertEqual(project, "BP")
        XCTAssertEqual(removed, ["/wt/one"], "what already went is named")
        XCTAssertTrue(reason.contains("/wt/two"), "the reason names the worktree: \(reason)")
        XCTAssertEqual(r.removed, ["/wt/one"], "it stops at the throw rather than carrying on")
        XCTAssertFalse(r.removed.contains("/co"), "the checkout survives a failed worktree delete")
        XCTAssertEqual(r.forgotten, [], "and the grant is not dropped, so the worker may still clean up")
    }

    func testAFailedCheckoutDeleteKeepsTheGrant() {
        let r = Recorder()
        r.failOn = "/co"

        let step = deletion(r).perform(project: "BP", path: "/co", root: "/co", worktrees: [])

        guard case .failed = step else {
            XCTFail("expected a failure, got \(step)")
            return
        }
        XCTAssertEqual(r.forgotten, [], "a directory nothing may touch, with nothing on screen, is the worse end")
    }

    /// A checkout already gone is not an error, and the grant still has to go — but it is not a
    /// removal either. The first version of this test asserted `.removed`, which would have told
    /// an operator a directory was deleted when it was still on disk under another name or on an
    /// unmounted volume. They would find out by going to look for it.
    func testACheckoutThatIsAlreadyGoneIsForgotten_notReported_asRemoved() {
        let r = Recorder()

        let step = deletion(r, exists: { _ in false }).perform(
            project: "BP", path: "/co", root: "/co", worktrees: [])

        XCTAssertEqual(step, .forgotten(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, [], "nothing to delete")
        XCTAssertEqual(r.forgotten, ["/co"], "but the allowlist entry is still stale")
    }

    // BP-428 review. A symlinked grant whose target is already gone: `exists` follows the link
    // and reads it as absent, same as the case above, but unlike an ordinary stale entry there is
    // still a link on disk — and nothing else in this file's success path touches `path` when
    // `wasThere` is false.
    func testADanglingSymlinkedGrantIsCleanedUpEvenWithNoTargetLeft() {
        let r = Recorder()

        let step = deletion(r, exists: { _ in false }, isSymlink: { _ in true }).perform(
            project: "BP", path: "/co", root: "/co", worktrees: [])

        XCTAssertEqual(step, .forgotten(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/co"], "the dangling link itself still has to go")
        XCTAssertEqual(r.forgotten, ["/co"])
    }

    /// The other side of the same distinction, so neither outcome can drift into the other.
    func testACheckoutThatWasThereIsReportedAsRemoved() {
        let r = Recorder()

        let step = deletion(r, exists: { _ in true }).perform(
            project: "BP", path: "/co", root: "/co", worktrees: [])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/co"])
    }

    // BP-428 review. A recorder cannot tell a symlink from the directory it points to — both are
    // just a string — so this runs `remove` for real, the way ProjectSyncRunner wires it
    // (`FileManager.removeItem(atPath:)`), against a real symlink on disk. `root` is what
    // `CheckoutRemoval.check` would have resolved the link to — computed the same way here as a
    // caller receives it from the verdict, not re-derived inside `perform`.
    func testASymlinkedCheckoutIsActuallyDeletedRatherThanJustItsLink() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("bp428-deletion-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let real = base.appendingPathComponent("real")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let link = base.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        let root = ((real.path as NSString).standardizingPath as NSString).resolvingSymlinksInPath

        let deletion = CheckoutDeletion(
            remove: { try FileManager.default.removeItem(atPath: $0) },
            exists: { FileManager.default.fileExists(atPath: $0) },
            forget: { _ in })

        let step = deletion.perform(project: "BP", path: link.path, root: root, worktrees: [])

        XCTAssertEqual(step, .removed(project: "BP", path: link.path))
        // The bug: `removeItem` on `path` deletes only the link, so without deleting `root`
        // instead, this directory — just confirmed deleted — would still be sitting on disk,
        // orphaned.
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: real.path),
            "the real checkout must be deleted, not merely the symlink that pointed at it")
        // The other half of the same review: the link itself must not be left dangling. This has
        // to ask with `destinationOfSymbolicLink`, not `fileExists` — `fileExists` follows a
        // symlink to its target, so it already reads a dangling one as absent whether or not the
        // link entry itself is still sitting there, and would pass this assertion either way.
        XCTAssertNil(
            try? FileManager.default.destinationOfSymbolicLink(atPath: link.path),
            "the symlink itself must not survive as a dangling leftover")
    }

    // BP-428 review, the regression the test above cannot catch: `root != path` is also true for
    // an ordinary checkout reached only through an ancestor symlink the OS maintains (`/tmp` →
    // `/private/tmp`), where deleting `root` already removed the one real directory and a second
    // `remove(path)` fails against what the first call just deleted — turning a clean `.removed`
    // into `.partiallyRemoved`. Gating the second delete on `isSymlink(path)` instead is what
    // avoids that; this is the control that pins the gate to the right signal without touching a
    // real filesystem.
    func testANonSymlinkedRootMismatchDoesNotAttemptASecondRemove() {
        let r = Recorder()

        let step = deletion(r, isSymlink: { _ in false }).perform(
            project: "BP", path: "/co", root: "/private/co", worktrees: [])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(
            r.removed, ["/private/co"],
            "only the resolved root is deleted — path is not a symlink, so there is no separate link entry to clean up")
    }

    // BP-428 review, round 4. An earlier version of this fix let a failed link cleanup turn a
    // completed deletion into `.failed` — the checkout genuinely gone, the operator told nothing
    // happened. The one place a false negative is worse than the truth: nothing else records
    // that the irreversible act already succeeded.
    func testAFailedLinkCleanupDoesNotTurnACompletedDeletionIntoAFailure() {
        let r = Recorder()
        r.failOn = "/link"

        let step = deletion(r, isSymlink: { $0 == "/link" }).perform(
            project: "BP", path: "/link", root: "/real", worktrees: [])

        XCTAssertEqual(step, .removed(project: "BP", path: "/link"))
        XCTAssertEqual(r.removed, ["/real"], "the checkout itself is gone regardless of what happened to the link")
    }

    // MARK: - removeIfSafe: the seam that used to live in an untested app target

    private func alwaysRefusing() -> CheckoutRemoval {
        CheckoutRemoval(run: { _, _ in (128, "nope") }, exists: { _ in true })
    }

    private func allowing(_ worktrees: [String]) -> CheckoutRemoval {
        CheckoutRemoval(
            run: { args, _ in
                if args.contains("--show-toplevel") { return (0, "/co\n") }
                if args.contains("--git-dir") || args.contains("--git-common-dir") { return (0, ".git") }
                if args.contains("worktree") {
                    return (0, porcelainZ((["/co"] + worktrees).map { "worktree \($0)" }.joined(separator: "\n\n")))
                }
                return (0, "")
            },
            exists: { _ in true })
    }

    /// `/co` answers as a linked worktree of a repository elsewhere — the shape `check` can never
    /// say `.go` to (BP-505). `--git-dir` and `--git-common-dir` differ, matching
    /// `LinkedWorktreeCheckTests`' own fixture for the same discriminator.
    private func linkedWorktree() -> CheckoutRemoval {
        CheckoutRemoval(
            run: { args, _ in
                if args.contains("--show-toplevel") { return (0, "/co\n") }
                if args.contains("--git-dir") { return (0, "/repo/.git/worktrees/co\n") }
                if args.contains("--git-common-dir") { return (0, "/repo/.git\n") }
                return (0, "")
            },
            exists: { _ in true })
    }

    /// Records what the operator was asked, so "it named every path" can be asserted rather than
    /// described, and answers whatever the test told it to.
    private final class Asked: @unchecked Sendable {
        var calls: [(project: String, paths: [String])] = []
        var answer = true

        func ask(_ project: String, _ paths: [String]) -> Bool {
            calls.append((project, paths))
            return answer
        }
    }

    private func idle() -> CheckoutDeletion.IsBusy { { false } }

    func testARefusalNeverReachesTheDisk() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(), checking: alwaysRefusing(),
            asking: { asked.ask($0, $1) })

        guard case .refused = step else { return XCTFail("expected the guard's refusal, got \(step)") }
        XCTAssertEqual(r.removed, [], "nothing is deleted when the guard says no")
        XCTAssertEqual(r.forgotten, [], "and the grant stays, so the worker may still clean up")
        XCTAssertEqual(asked.calls.count, 0, "nobody is asked about a deletion that is not going to happen")
    }

    // MARK: - BP-505: a linked worktree converges instead of refusing for ever

    /// The fix. Left as a plain refusal, this repeats identically on every reconnect: the shape is
    /// structural, so nothing about waiting changes the guard's answer. Dropping the grant is the
    /// only path that reaches a resolved state, and it deletes nothing — the same outcome
    /// Preferences → Repositories → Remove already gives by hand.
    func testALinkedWorktreeDropsTheGrantWithoutDeletingAnything() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(), checking: linkedWorktree(),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .linkedWorktreeDropped(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, [], "the checkout it belongs to is untouched")
        XCTAssertEqual(r.forgotten, ["/co"], "but the grant goes, so this does not repeat forever")
        XCTAssertEqual(asked.calls.count, 0, "nothing is being deleted, so there is nothing to ask about")
    }

    /// The control that keeps the case above honest: a step naming success requires the write to
    /// have actually happened.
    func testALinkedWorktreeWhoseGrantCannotBeDroppedIsReportedFailed() async {
        let r = Recorder()
        r.failForget = true
        let asked = Asked()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(), checking: linkedWorktree(),
            asking: { asked.ask($0, $1) })

        guard case .failed(let project, let reason) = step else {
            return XCTFail("expected a failure, got \(step)")
        }
        XCTAssertEqual(project, "BP")
        XCTAssertTrue(reason.contains("/co"), reason)
        XCTAssertEqual(r.removed, [])
    }

    /// The exotic half: `removeIfSafe` re-checks right before deleting, in case the operator's
    /// confirmation dialog sat on screen long enough for something to change (BP-378/BP-424). This
    /// answers a linked worktree only on the *second* look — a transition nothing in this app's own
    /// flow produces, since the shape is structural rather than a state that changes underneath a
    /// modal, but the switch has to answer for it, and only this test drives that arm.
    func testABecomingLinkedWorktreeBetweenTheTwoLooksStillDropsTheGrantRatherThanDeleting() async {
        let r = Recorder()
        let asked = Asked()
        let git = BecomesALinkedWorktreeOnItsSecondLook()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: CheckoutRemoval(run: { args, cwd in git.run(args, cwd) }, exists: { _ in true }),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .linkedWorktreeDropped(project: "BP", path: "/co"))
        XCTAssertEqual(asked.calls.count, 1, "asked on the first look, before anything changed")
        XCTAssertEqual(r.removed, [], "the second look says linked worktree, so nothing is deleted")
        XCTAssertEqual(r.forgotten, ["/co"])
    }

    /// What the guard found is what gets deleted. The two used to be wired together by hand in the
    /// app target, where passing an empty list would have deleted no worktrees and told nobody.
    func testItDeletesExactlyTheWorktreesTheGuardFound() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: allowing(["/wt/one", "/wt/two"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/wt/two", "/co"])
    }

    // MARK: - BP-378: unticking is a proposal, and the machine is where it is put

    /// The criterion, directly: every resolved path is named — the checkout and each linked
    /// worktree — and they are the paths the guard resolved, not ones the server guessed.
    func testTheOperatorIsAskedWithTheCheckoutAndEveryWorktree() async {
        let r = Recorder()
        let asked = Asked()

        _ = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: allowing(["/wt/one", "/wt/two"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(asked.calls.count, 1, "asked once, immediately before the delete")
        XCTAssertEqual(asked.calls.first?.project, "BP")
        XCTAssertEqual(
            asked.calls.first?.paths, ["/co", "/wt/one", "/wt/two"],
            "the checkout first, then what goes with it — nothing deleted goes unnamed")
    }

    // BP-428 review. What the operator actually confirms deleting when the grant is a symlink —
    // the granted path alone would let them agree without ever seeing where the delete really
    // lands. Real git and a real symlink throughout: `sameDirectory` only agrees a mismatched
    // root and path name the same directory once it can resolve one — a mock pair, neither of
    // which exists on disk, cannot exercise that the way a real checkout can.
    func testTheOperatorIsShownWhatASymlinkedGrantActuallyResolvesTo() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("bp428-dialog-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let real = base.appendingPathComponent("real")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        _ = reachGitForDeletionTests(real.path, ["init", "-q", "-b", "main"])
        let link = base.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        let root = reachGitForDeletionTests(link.path, ["rev-parse", "--show-toplevel"]).output
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let r = Recorder()
        let asked = Asked()
        let removal = CheckoutRemoval(run: { args, cwd in reachGitForDeletionTests(cwd, args) })

        // The default `isSymlink` in `deletion(_:)` answers `{ _ in false }`, deliberately, for
        // every other test in this file's synthetic paths — here the point is a real one, so the
        // real check is asked instead.
        _ = await deletion(r, isSymlink: CheckoutDeletion.realIsSymlink).removeIfSafe(
            project: "BP", path: link.path, isBusy: idle(),
            checking: removal,
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(
            asked.calls.first?.paths, ["\(link.path) → \(root)"],
            "the dialog names both the grant and what it resolves to, not only the allowlist's own bookkeeping")
    }

    func testDecliningDeletesNothingAndKeepsTheGrant() async {
        let r = Recorder()
        let asked = Asked()
        asked.answer = false

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: allowing(["/wt/one"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .declined(project: "BP", paths: ["/co", "/wt/one"]))
        XCTAssertEqual(r.removed, [], "no is a no about the disk")
        XCTAssertEqual(
            r.forgotten, [],
            "and about the allowlist: dropping the grant would leave a checkout the worker may no longer touch")
    }

    /// A checkout that went on its own. The grant is stale and dropping it destroys nothing, so
    /// putting a deletion dialog in front of somebody would be asking about nothing.
    func testNothingToDeleteIsNotWorthAsking() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r, exists: { _ in false }).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(), checking: allowing([]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .forgotten(project: "BP", path: "/co"))
        XCTAssertEqual(asked.calls.count, 0, "nothing was going to be deleted")
        XCTAssertEqual(r.forgotten, ["/co"], "the stale entry still goes")
    }

    /// BP-424 with a longer window. That ticket was about a worker picking up a task during a
    /// clone; a modal waits on a person, which is longer still. A `removeIfSafe` that asked once
    /// before the dialog would pass every test above and delete a live worktree here.
    func testAWorkerThatPicksUpATaskWhileTheQuestionIsOnScreenStopsTheDelete() async {
        let r = Recorder()
        let asked = Asked()
        let busy = Counter()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: { busy.next() },
            checking: allowing(["/wt/one"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(asked.calls.count, 1, "it did ask — the worker was idle when the guards ran")
        guard case .refused(_, let reason) = step else {
            return XCTFail("expected a refusal on the second look, got \(step)")
        }
        XCTAssertTrue(reason.contains("running a task"), "and says why: \(reason)")
        XCTAssertEqual(r.removed, [], "nothing is taken from under a run")
        XCTAssertEqual(r.forgotten, [])
    }

    /// The operator agreed to a list. A worktree created while the dialog sat on screen is not on
    /// it, and deleting it would be destroying something they were never shown.
    func testAWorktreeThatAppearsWhileTheQuestionIsOnScreenStopsTheDelete() async {
        let r = Recorder()
        let asked = Asked()
        let worktrees = Growing(first: ["/wt/one"], then: ["/wt/one", "/wt/late"])

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: CheckoutRemoval(
                run: { args, _ in stubGit(args, worktrees: worktrees) },
                exists: { _ in true }),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(asked.calls.first?.paths, ["/co", "/wt/one"], "asked about what was there then")
        guard case .refused(_, let reason) = step else {
            return XCTFail("expected a refusal, got \(step)")
        }
        // The line lands in the Repositories pane as something to act on, so it has to name what
        // changed. "Something changed" is not something anybody can act on.
        XCTAssertTrue(reason.contains("/wt/late appeared"), reason)
        XCTAssertTrue(reason.contains("while the question was on screen"), reason)
        XCTAssertTrue(reason.contains("it will ask again"), reason)
        XCTAssertEqual(r.removed, [], "and /wt/late, which nobody was shown, is still there")
    }

    /// The control for the two above: when nothing changes between the two looks, agreeing still
    /// deletes. Without it, a `removeIfSafe` that refused everything after a confirmation would
    /// pass both.
    func testAgreeingWithNothingChangingStillDeletes() async {
        let r = Recorder()
        let asked = Asked()

        let step = await deletion(r).removeIfSafe(
            project: "BP", path: "/co", isBusy: idle(),
            checking: allowing(["/wt/one"]),
            asking: { asked.ask($0, $1) })

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/co"])
        XCTAssertEqual(r.forgotten, ["/co"])
    }

    // MARK: - BP-427: what the operator is told when only some of it went

    /// The checkout itself refuses after both worktrees are already gone. The old step named the
    /// checkout and nothing else, which reads as "nothing was deleted" — the opposite of the truth.
    func testAFailedCheckoutDeleteStillNamesTheWorktreesThatWent() {
        let r = Recorder()
        r.failOn = "/co"

        let step = deletion(r).perform(
            project: "BP", path: "/co", root: "/co", worktrees: ["/wt/one", "/wt/two"])

        XCTAssertEqual(
            step,
            .partiallyRemoved(
                project: "BP", removed: ["/wt/one", "/wt/two"], reason: "could not remove /co"))
        XCTAssertEqual(r.forgotten, [], "the grant stays, so the worker may still clean up")
    }

    /// Everything is deleted and only the allowlist write fails. The disk is in its final state and
    /// the grant is not — the one case where "partly done" means the directory is gone.
    func testAFailedForgetAfterEverythingWentIsStillPartial() {
        let r = Recorder()
        r.failForget = true

        let step = deletion(r).perform(project: "BP", path: "/co", root: "/co", worktrees: ["/wt/one"])

        guard case .partiallyRemoved(_, let removed, _) = step else {
            return XCTFail("expected a partial removal, got \(step)")
        }
        XCTAssertEqual(removed, ["/wt/one", "/co"], "the checkout is gone and has to be named")
    }

    /// The control that keeps the new case honest: when the very first act throws, nothing went,
    /// and "partly removed" would be its own kind of lie.
    func testAFirstActThatThrowsIsStillAPlainFailure() {
        let r = Recorder()
        r.failOn = "/wt/one"

        let step = deletion(r).perform(project: "BP", path: "/co", root: "/co", worktrees: ["/wt/one", "/wt/two"])

        XCTAssertEqual(step, .failed(project: "BP", reason: "could not remove /wt/one"))
        XCTAssertEqual(r.removed, [], "and nothing reached the disk")
    }

    /// The other control: a removal that finishes is reported exactly as it was before.
    func testACompleteRemovalIsUnchanged() {
        let r = Recorder()

        let step = deletion(r).perform(project: "BP", path: "/co", root: "/co", worktrees: ["/wt/one"])

        XCTAssertEqual(step, .removed(project: "BP", path: "/co"))
        XCTAssertEqual(r.removed, ["/wt/one", "/co"])
        XCTAssertEqual(r.forgotten, ["/co"])
    }
}

/// Idle on the first question, running on every one after it — the worker picking up a task while
/// the confirmation is on screen.
private final class Counter: @unchecked Sendable {
    private var asked = 0
    func next() -> Bool {
        defer { asked += 1 }
        return asked > 0
    }
}

/// One set of worktrees for the first `check`, another for the second.
private final class Growing: @unchecked Sendable {
    private let first: [String]
    private let then: [String]
    private var looks = 0

    init(first: [String], then: [String]) {
        self.first = first
        self.then = then
    }

    func next() -> [String] {
        defer { looks += 1 }
        return looks == 0 ? first : then
    }
}

/// A git that answers every question `CheckoutRemoval` asks with yes, naming whichever set of
/// worktrees this look is meant to see. The set advances on the `worktree list` call alone — a
/// check runs half a dozen git commands, and advancing on each one made the first look already see
/// the second set.
@Sendable private func stubGit(_ args: [String], worktrees: Growing) -> (code: Int32, output: String) {
    if args.contains("--show-toplevel") { return (0, "/co\n") }
    if args.contains("--git-dir") || args.contains("--git-common-dir") { return (0, ".git") }
    if args.contains("worktree") {
        let listed = worktrees.next()
        return (0, porcelainZ((["/co"] + listed).map { "worktree \($0)" }.joined(separator: "\n\n")))
    }
    return (0, "")
}

/// An ordinary, clean repository on the first `check`, a linked worktree on the second —
/// `--show-toplevel` is the first git call inside every `check` invocation, so counting it (not
/// deferred: every later call in *this same* invocation must still see the bumped count) tells the
/// rest of the stub which invocation it is answering for.
private final class BecomesALinkedWorktreeOnItsSecondLook: @unchecked Sendable {
    private var invocation = 0

    func run(_ args: [String], _ cwd: String) -> (code: Int32, output: String) {
        if args.contains("--show-toplevel") {
            invocation += 1
            return (0, "/co\n")
        }
        guard invocation >= 2 else {
            if args.contains("--git-dir") || args.contains("--git-common-dir") { return (0, ".git") }
            return (0, "")
        }
        if args.contains("--git-dir") { return (0, "/repo/.git/worktrees/co\n") }
        if args.contains("--git-common-dir") { return (0, "/repo/.git\n") }
        return (0, "")
    }
}
