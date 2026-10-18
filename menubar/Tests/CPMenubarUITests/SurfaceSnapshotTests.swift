import SwiftUI
import XCTest
@testable import CPMenubar
@testable import CPMenubarCore

@MainActor
final class SurfaceSnapshotTests: XCTestCase {
    func testPanel() {
        for (name, state) in [
            ("panel-idle", Fixtures.idle), ("panel-working", Fixtures.working),
            ("panel-needs-human", Fixtures.needsHuman), ("panel-fault", Fixtures.faulted),
            ("panel-offline", Fixtures.disconnected), ("panel-paused", Fixtures.paused),
        ] {
            Snapshot.render(
                PanelView(model: AppModel(previewState: state, config: Fixtures.config)),
                name: name, width: 320)
        }
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

        let running = OnboardingModel(previewState: Fixtures.onboarding(step: .running))
        Snapshot.render(FirstRunView(onboarding: running), name: "connect-connected", width: 380)
    }

    func testPreferences() {
        let model = AppModel(previewState: Fixtures.idle, config: Fixtures.config)
        let onboarding = OnboardingModel(previewState: Fixtures.onboarding(step: .running))
        Snapshot.render(
            PreferencesView(model: model, onboarding: onboarding),
            name: "preferences-default", width: 460, height: 320)
    }
}
