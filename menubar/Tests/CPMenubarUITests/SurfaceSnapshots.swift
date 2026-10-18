import SwiftUI
import XCTest
@testable import CPMenubar
@testable import CPMenubarCore

// A screenshot generator, not a test of behaviour: what the screens say is tested in
// CPMenubarCoreTests (PanelSummary, QuotaSummary, IconGlyph, ConnectReadiness). It runs only with
// CP_SNAPSHOT_DIR set, against a scratch state directory so it never reads the developer's own.
@MainActor
final class SurfaceSnapshots: XCTestCase {
    private var scratch: String?

    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["CP_SNAPSHOT_DIR"] != nil,
            "set CP_SNAPSHOT_DIR to render the screens")
        let directory = NSTemporaryDirectory() + "cp-snapshot-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        try ReposFile(path: ReposFile.path(in: directory)).write(
            ["/Users/dev/Workspace/BP", "/Users/dev/Workspace/FNV", "/Users/dev/Workspace/SB"])
        try GithubAccountFile(path: GithubAccountFile.path(in: directory)).write("rafalpodles")
        StateDirectory.set(directory)
        scratch = directory
    }

    override func tearDown() {
        StateDirectory.set(nil)
        if let scratch { try? FileManager.default.removeItem(atPath: scratch) }
    }

    func testPanel() {
        for (name, state) in [
            ("panel-idle", Fixtures.idle), ("panel-working", Fixtures.working),
            ("panel-needs-human", Fixtures.needsHuman), ("panel-fault", Fixtures.faulted),
            ("panel-offline", Fixtures.disconnected), ("panel-paused", Fixtures.paused),
            ("panel-paused-running", Fixtures.pausedWhileRunning),
        ] {
            Snapshot.render(
                PanelView(model: AppModel(previewState: state, config: Fixtures.config)),
                name: name, width: 340)
        }
    }

    func testMenuBarIcon() {
        struct Strip: View {
            var body: some View {
                let states: [(String, WorkerState)] = [
                    ("Idle", Fixtures.idle), ("Paused", Fixtures.paused), ("Needs a human", Fixtures.needsHuman),
                    ("Fault", Fixtures.faulted), ("Offline", Fixtures.disconnected),
                ] + (0..<WorkerState.pipeline.count).map { index in
                    (WorkerState.stageLabels[index], Fixtures.state {
                        $0.apply(.progress(Progress(phase: WorkerState.pipeline[index], taskKey: "BP-1")), at: Fixtures.t0)
                    })
                }
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(states.enumerated()), id: \.offset) { _, entry in
                        HStack(spacing: 12) {
                            Image(nsImage: MenuBarGlyph.image(entry.1.iconGlyph(now: Date()), breath: 1))
                                .renderingMode(.template).foregroundStyle(.primary)
                            Image(nsImage: MenuBarGlyph.image(entry.1.iconGlyph(now: Date()), breath: 1))
                                .resizable().interpolation(.high)
                                .renderingMode(.template).foregroundStyle(.primary)
                                .frame(width: 60, height: 48)
                            Text(entry.0).font(.callout)
                        }
                    }
                }
                .padding(16)
            }
        }
        Snapshot.render(Strip(), name: "menubar-icon-states", width: 260)
    }

    func testConnect() {
        let blocked = OnboardingModel(
            previewState: Fixtures.onboarding(step: .needsPreflight),
            preflight: Fixtures.preflight(claudeSignedIn: false),
            githubAccounts: Fixtures.preflight(claudeSignedIn: false).githubAccounts ?? [])
        Snapshot.render(FirstRunView(onboarding: blocked), name: "connect-blocked", width: 380)

        let ready = OnboardingModel(
            previewState: Fixtures.onboarding(step: .needsPreflight),
            preflight: Fixtures.preflight(claudeSignedIn: true),
            githubAccounts: Fixtures.preflight(claudeSignedIn: true).githubAccounts ?? [])
        Snapshot.render(FirstRunView(onboarding: ready), name: "connect-ready", width: 380)

        let approving = OnboardingModel(
            previewState: Fixtures.onboarding(step: .awaitingApproval, userCode: "KQ4-7ZP"))
        Snapshot.render(FirstRunView(onboarding: approving), name: "connect-approve", width: 380)

        let fresh = OnboardingModel(previewState: {
            var state = Fixtures.onboarding(step: .needsFolder)
            state.checkoutsFolder = ""
            return state
        }())
        Snapshot.render(FirstRunView(onboarding: fresh), name: "connect-fresh", width: 380)

        let cloning = OnboardingModel(
            previewState: Fixtures.onboarding(step: .starting),
            message: "Cloning https://github.com/rafalpodles/board-planner…", busy: true)
        Snapshot.render(FirstRunView(onboarding: cloning), name: "connect-setting-up", width: 380)

        let refused = OnboardingModel(
            previewState: Fixtures.onboarding(step: .starting),
            setupFailure: .init(
                stage: .cloning,
                reason: "Cloned, but this machine cannot push to it: remote: Write access to repository not granted."))
        Snapshot.render(FirstRunView(onboarding: refused), name: "connect-setting-up-failed", width: 380)

        let checkedAfterFailure = OnboardingModel(
            previewState: Fixtures.onboarding(step: .starting),
            preflight: Fixtures.preflight(claudeSignedIn: false),
            message: "Could not reach https://app.board-planner.com — The Internet connection appears to be offline.")
        Snapshot.render(FirstRunView(onboarding: checkedAfterFailure), name: "connect-setting-up-checked", width: 380)

        let interrupted = OnboardingModel(previewState: Fixtures.onboarding(step: .starting))
        Snapshot.render(FirstRunView(onboarding: interrupted), name: "connect-setting-up-unfinished", width: 380)
    }

    func testPreferences() {
        let model = AppModel(previewState: Fixtures.idle, config: Fixtures.config)
        let onboarding = OnboardingModel(previewState: Fixtures.onboarding(step: .running))
        for (name, tab) in [
            ("preferences-connection", PreferencesView.Tab.connection),
            ("preferences-projects", .projects), ("preferences-advanced", .advanced),
        ] {
            Snapshot.render(
                PreferencesView(model: model, onboarding: onboarding, initialTab: tab),
                name: name, width: 540, height: 480)
        }
    }
}
