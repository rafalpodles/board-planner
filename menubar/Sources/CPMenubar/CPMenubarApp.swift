import SwiftUI
import CPMenubarCore

@main
struct CPMenubarApp: App {
    // No default initialiser here: writing `= AppModel()` alongside the assignment below constructs
    // two models, starts the pump on one and renders the other.
    @State private var model: AppModel

    init() {
        let model = AppModel()
        _model = State(initialValue: model)
        model.start()
        Notifier.shared.requestAuthorization()
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: model)
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
    }
}
