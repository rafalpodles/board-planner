import XCTest
import CPMenubarCore
@testable import CPMenubar

final class ConnectCommandTests: XCTestCase {
    func testParseDefaultsTheFolderUnderHome() {
        XCTAssertEqual(
            ConnectCommand.parse(["app", "--connect", "https://acme.example.com"], home: "/Users/a", workingDirectory: "/tmp"),
            .run(.init(boardURL: "https://acme.example.com", folder: "/Users/a/board-planner")))
    }

    func testParseResolvesARelativeFolderAgainstTheWorkingDirectory() {
        XCTAssertEqual(
            ConnectCommand.parse(
                ["app", "--connect", "https://b", "--folder", "../work"], home: "/Users/a", workingDirectory: "/Users/a/code"),
            .run(.init(boardURL: "https://b", folder: "/Users/a/work")))
    }

    func testParseRefusesWhatItDoesNotKnow() {
        XCTAssertEqual(ConnectCommand.parse(["app", "--connect"], home: "/h", workingDirectory: "/"), .usage)
        XCTAssertEqual(ConnectCommand.parse(["app", "--connect", "--folder", "x"], home: "/h", workingDirectory: "/"), .usage)
        XCTAssertEqual(ConnectCommand.parse(["app", "--connect", "https://b", "--folder"], home: "/h", workingDirectory: "/"), .usage)
        XCTAssertEqual(ConnectCommand.parse(["app", "--connect", "https://b", "--repo", "x"], home: "/h", workingDirectory: "/"), .usage)
        XCTAssertEqual(ConnectCommand.parse(["app", "--connect", "https://b", "--folder", ""], home: "/h", workingDirectory: "/"), .usage)
        XCTAssertEqual(ConnectCommand.parse(["app", "--preflight"], home: "/h", workingDirectory: "/"), .notRequested)
        XCTAssertEqual(ConnectCommand.parse(["app"], home: "/h", workingDirectory: "/"), .notRequested)
    }

    func testHappyPathApprovesClonesGrantsAndHandsOverToTheApp() async {
        let rig = Rig(polls: [.pending, .approved(workerID: "w1", credential: "cpw_x", heartbeatMs: 30_000, repositoryURL: "https://github.com/acme/api.git", projectKey: "PAY")])
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 0)
        XCTAssertEqual(rig.saved.last?.step, .running)
        XCTAssertEqual(rig.saved.last?.apiURL, "https://acme.example.com")
        XCTAssertEqual(rig.saved.last?.checkoutsFolder, "/Users/a/board-planner")
        XCTAssertEqual(rig.saved.last?.checkoutPath, "/Users/a/board-planner/PAY")
        XCTAssertEqual(rig.saved.last?.deviceCode, "", "the spent device code is not left behind")
        XCTAssertEqual(rig.identity, WorkerIdentity(workerId: "w1", credential: "cpw_x", heartbeatMs: 30_000))
        XCTAssertEqual(rig.granted, ["/Users/a/board-planner/PAY"])
        XCTAssertEqual(rig.opened, ["https://acme.example.com/enrol/ABCD-EFGH"])
        XCTAssertEqual(rig.appOpened, 1)
        XCTAssertTrue(rig.lines.contains { $0.contains("ABCD-EFGH") })
    }

    func testARefusedApprovalStopsWithoutACredential() async {
        let rig = Rig(polls: [.pending, .finished])
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertNil(rig.identity)
        XCTAssertEqual(rig.saved.last?.deviceCode, "")
        XCTAssertNotEqual(rig.saved.last?.step, .running)
        XCTAssertEqual(rig.appOpened, 0)
    }

    func testAMachineThatFailsItsChecksIsNeverEnrolled() async {
        let rig = Rig(polls: [], preflightOK: false)
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertEqual(rig.begun, 0)
        XCTAssertTrue(rig.lines.contains("  ✗ gh: not signed in"))
    }

    func testAFolderThatIsItselfACheckoutIsRefusedBeforeAnythingElse() async {
        let rig = Rig(polls: [], folderIsCheckout: true)
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertEqual(rig.preflights, 0)
        XCTAssertEqual(rig.begun, 0)
    }

    func testAFailedCloneIsNotStartedButKeepsTheCredential() async {
        let rig = Rig(
            polls: [.approved(workerID: "w1", credential: "cpw_x", heartbeatMs: 1, repositoryURL: "https://github.com/acme/api.git", projectKey: "PAY")],
            clone: .failed(reason: "Cloned, but this machine cannot push to it"))
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertNotNil(rig.identity)
        XCTAssertEqual(rig.saved.last?.step, .starting)
        XCTAssertEqual(rig.granted, [])
        XCTAssertEqual(rig.appOpened, 0)
    }

    func testAWorkerAlreadyRunningOutsideTheAppStopsTheCommand() async {
        let rig = Rig(polls: [])
        rig.staleWorker = true
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertEqual(rig.begun, 0)
        XCTAssertEqual(rig.saved, [])
    }

    func testAnAlreadyConnectedMacWhoseWorkerIsDownIsNotReportedAsFine() async {
        let rig = Rig(polls: [], initial: OnboardingState(step: .running, apiURL: "https://acme.example.com", workerName: "Mac"))
        rig.listening = false
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertEqual(rig.begun, 0)
    }

    func testAnAlreadyConnectedMacOnTheSameBoardDoesNothing() async {
        let rig = Rig(polls: [], initial: OnboardingState(step: .running, apiURL: "https://acme.example.com", workerName: "Mac"))
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 0)
        XCTAssertEqual(rig.begun, 0)
        XCTAssertEqual(rig.saved, [])
    }

    func testAMacConnectedToAnotherBoardIsNotMovedSilently() async {
        let rig = Rig(polls: [], initial: OnboardingState(step: .running, apiURL: "https://other.example.com", workerName: "Mac"))
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertEqual(rig.begun, 0)
        XCTAssertEqual(rig.saved, [])
    }

    func testAnOpenSetupWindowIsClosedBeforeItsStateIsWritten() async {
        let rig = Rig(polls: [.finished], otherRunning: true)
        _ = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(rig.events.first, "close")
        XCTAssertEqual(rig.events.dropFirst().first, "save")
    }

    func testACopyOutsideTheAppRefusesBeforeTouchingAnything() async {
        let rig = Rig(polls: [], otherRunning: true, insideTheApp: false)
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertFalse(rig.events.contains("close"))
        XCTAssertEqual(rig.saved, [])
        XCTAssertEqual(rig.preflights, 0)
    }

    func testAnApprovalStartedEarlierIsPickedUpRatherThanStartedAgain() async {
        var waiting = OnboardingState(step: .awaitingApproval, apiURL: "https://acme.example.com", workerName: "Mac")
        waiting.deviceCode = "old-device"
        waiting.userCode = "OLD-CODE"
        waiting.verificationURL = "https://acme.example.com/enrol/OLDCODE"
        let rig = Rig(
            polls: [.approved(workerID: "w1", credential: "c", heartbeatMs: 1, repositoryURL: "https://github.com/acme/api.git", projectKey: "PAY")],
            initial: waiting)
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 0)
        XCTAssertEqual(rig.begun, 0)
        XCTAssertEqual(rig.polledCodes, ["old-device"])
        XCTAssertEqual(rig.opened, ["https://acme.example.com/enrol/OLDCODE"])
    }

    func testAnApprovalForAnotherBoardIsNotPickedUp() async {
        var waiting = OnboardingState(step: .awaitingApproval, apiURL: "https://other.example.com", workerName: "Mac")
        waiting.deviceCode = "old-device"
        let rig = Rig(polls: [.finished], initial: waiting)
        _ = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(rig.begun, 1)
        XCTAssertEqual(rig.polledCodes, ["dev"])
    }

    func testAWindowThatWillNotQuitStopsTheCommand() async {
        let rig = Rig(polls: [], otherRunning: true)
        rig.closes = false
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertEqual(rig.saved, [])
        XCTAssertEqual(rig.begun, 0)
    }

    func testTheStateIsReadAgainAfterTheWindowQuits() async {
        let rig = Rig(polls: [], otherRunning: true)
        rig.stateAfterClose = OnboardingState(step: .running, apiURL: "https://acme.example.com", workerName: "Mac")
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 0)
        XCTAssertEqual(rig.begun, 0)
        XCTAssertEqual(rig.saved, [])
    }

    func testAFailureAfterClosingTheWindowOpensTheAppAgain() async {
        let rig = Rig(polls: [], preflightOK: false, otherRunning: true)
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertEqual(rig.appOpened, 1)
    }

    func testAWorkerThatNeverStartsIsNotReportedAsConnected() async {
        let rig = Rig(polls: [.approved(workerID: "w1", credential: "c", heartbeatMs: 1, repositoryURL: "https://github.com/acme/api.git", projectKey: "PAY")])
        rig.listening = false
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertFalse(rig.lines.contains { $0.hasPrefix("✓ Connected") })
    }

    func testAnAppThatWillNotOpenIsNotReportedAsConnected() async {
        let rig = Rig(polls: [.approved(workerID: "w1", credential: "c", heartbeatMs: 1, repositoryURL: "https://github.com/acme/api.git", projectKey: "PAY")])
        rig.opens = false
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertFalse(rig.lines.contains { $0.hasPrefix("✓ Connected") })
    }

    func testTheFolderIsStoredWithItsLinksResolved() async {
        let rig = Rig(polls: [.finished])
        rig.options.folder = "/Users/a/link/board-planner"
        _ = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(rig.saved.first?.checkoutsFolder, "/Users/a/real/board-planner")
    }

    func testANetworkThatNeverAnswersEndsTheWait() async {
        let rig = Rig(polls: [], pollFails: true)
        let code = await ConnectCommand.run(rig.options, rig.deps)

        XCTAssertEqual(code, 1)
        XCTAssertEqual(rig.polled, ConnectCommand.unreachablePollLimit)
    }
}

private final class Rig: @unchecked Sendable {
    var options = ConnectCommand.Options(boardURL: "https://acme.example.com/", folder: "/Users/a/board-planner")
    private let lock = NSLock()
    private var polls: [DeviceEnrolmentPoll]
    private let preflightOK: Bool
    private let folderIsCheckout: Bool
    private let cloneOutcome: CloneOutcome?
    private let otherRunning: Bool
    private let pollFails: Bool
    private let insideTheApp: Bool
    var closes = true
    var opens = true
    var listening = true
    var staleWorker = false
    var workerChecks: [Int] = []
    var stateAfterClose: OnboardingState?
    private var state: OnboardingState

    var lines: [String] = []
    var saved: [OnboardingState] = []
    var events: [String] = []
    var identity: WorkerIdentity?
    var granted: [String] = []
    var opened: [String] = []
    var appOpened = 0
    var begun = 0
    var preflights = 0
    var polled = 0
    var polledCodes: [String] = []

    init(
        polls: [DeviceEnrolmentPoll], preflightOK: Bool = true, folderIsCheckout: Bool = false,
        clone: CloneOutcome? = nil, otherRunning: Bool = false, pollFails: Bool = false, insideTheApp: Bool = true,
        initial: OnboardingState = OnboardingState()
    ) {
        self.polls = polls
        self.preflightOK = preflightOK
        self.folderIsCheckout = folderIsCheckout
        self.cloneOutcome = clone
        self.otherRunning = otherRunning
        self.pollFails = pollFails
        self.insideTheApp = insideTheApp
        self.state = initial
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    var deps: ConnectCommand.Deps {
        ConnectCommand.Deps(
            say: { line in self.locked { self.lines.append(line) } },
            load: { self.locked { self.state } },
            save: { next in self.locked { self.state = next; self.saved.append(next); self.events.append("save") } },
            insideTheApp: self.insideTheApp,
            otherInstanceRunning: { self.otherRunning },
            closeOtherInstance: {
                self.locked {
                    self.events.append("close")
                    if let next = self.stateAfterClose { self.state = next }
                    return self.closes
                }
            },
            makeFolder: { _ in },
            resolve: { $0.replacingOccurrences(of: "/link/", with: "/real/") },
            inspect: { path in
                RepositoryInspection(
                    exists: true, isDirectory: true, resolved: path, hasGitDirectory: self.folderIsCheckout,
                    posixPermissions: 0o755, ownedByCurrentUser: true)
            },
            preflight: { _ in
                self.locked { self.preflights += 1 }
                return PreflightReport(
                    ok: self.preflightOK, account: "a",
                    checks: [
                        .init(name: "claude", ok: true, detail: "signed in"),
                        .init(name: "gh", ok: self.preflightOK, detail: self.preflightOK ? "signed in" : "not signed in"),
                    ],
                    paths: ["git": "/usr/bin/git"], path: "/usr/bin", githubAccounts: nil, githubAccount: nil,
                    githubPinned: nil)
            },
            machineName: "MacBook-Pro",
            host: "mbp.local",
            begin: { board, _, _ in
                self.locked { self.begun += 1 }
                return try JSONDecoder().decode(
                    DeviceEnrolmentStart.self,
                    from: Data(#"{"deviceCode":"dev","userCode":"ABCD-EFGH","verificationUrl":"\#(board)/enrol/ABCD-EFGH","intervalMs":1}"#.utf8))
            },
            poll: { _, code in
                try self.locked {
                    self.polled += 1
                    self.polledCodes.append(code)
                    if self.pollFails { throw URLError(.notConnectedToInternet) }
                    return self.polls.isEmpty ? .finished : self.polls.removeFirst()
                }
            },
            sleep: { _ in },
            openBrowser: { url in self.locked { self.opened.append(url) } },
            writeIdentity: { identity in self.locked { self.identity = identity } },
            clone: { state, _, key in
                self.cloneOutcome ?? .cloned(path: CloneStep.destination(parent: state.checkoutsFolder, projectKey: key))
            },
            grant: { path in self.locked { self.granted.append(path) } },
            openApp: { self.locked { self.appOpened += 1; return self.opens } },
            workerAnswers: { seconds in
                self.locked {
                    self.workerChecks.append(seconds)
                    return seconds == 0 ? self.staleWorker : self.listening
                }
            }
        )
    }
}
