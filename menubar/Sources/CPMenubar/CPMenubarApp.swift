import SwiftUI
import CPMenubarCore

@main
struct CPMenubarApp: App {
    @State private var model: AppModel
    @State private var onboarding: OnboardingModel

    init() {
        LoginItemCommand.runIfRequested()

        let model = AppModel()
        _model = State(initialValue: model)
        model.start()

        let onboarding = OnboardingModel()
        _onboarding = State(initialValue: onboarding)
        Task { await onboarding.resumeWorker() }

        Notifier.shared.requestAuthorization()
    }

    var body: some Scene {
        MenuBarExtra {
            if onboarding.state.isOnboarded {
                PanelView(model: model)
            } else {
                FirstRunView(onboarding: onboarding)
            }
        } label: {
            if let title = model.state.title(now: Date()) {
                Label(title, systemImage: model.state.iconName())
            } else {
                Image(systemName: model.state.iconName())
            }
        }
        .menuBarExtraStyle(.window)

        Settings { PreferencesView(model: model, onboarding: onboarding) }
    }
}
