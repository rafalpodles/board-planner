import SwiftUI
import CPMenubarCore

@main
struct CPMenubarApp: App {
    // No default initialiser here: writing `= AppModel()` alongside the assignment below constructs
    // two models, starts the pump on one and renders the other.
    @State private var model: AppModel
    @State private var onboarding: OnboardingModel

    init() {
        // A scriptable way to exercise the login item without clicking through the menu bar. It
        // has to run from inside the .app bundle, which is exactly the configuration whose
        // behaviour this is checking — SMAppService reads the main bundle, not the executable.
        LoginItemCommand.runIfRequested()

        let model = AppModel()
        _model = State(initialValue: model)
        model.start()

        // Same reason as the model above: constructing this inline would make two, and the one that
        // resumes the worker would not be the one on screen.
        let onboarding = OnboardingModel()
        _onboarding = State(initialValue: onboarding)
        Task { await onboarding.resumeWorker() }

        Notifier.shared.requestAuthorization()
    }

    var body: some Scene {
        MenuBarExtra {
            // An app with no identity has nothing to observe, so it offers setup instead of
            // "Can't reach the worker" — which is what a new user sees today and cannot act on.
            if onboarding.state.isOnboarded {
                PanelView(model: model)
            } else {
                FirstRunView(onboarding: onboarding)
            }
        } label: {
            // The menu bar renders this as a template image, so state is carried by which symbol it
            // is rather than by colour.
            if let title = model.state.title(now: Date()) {
                Label(title, systemImage: model.state.iconName())
            } else {
                Image(systemName: model.state.iconName())
            }
        }
        .menuBarExtraStyle(.window)

        // The same onboarding object the panel renders, so changing boards in Preferences puts
        // the panel back on the first-run screen rather than leaving two views disagreeing.
        Settings { PreferencesView(model: model, onboarding: onboarding) }
    }
}
