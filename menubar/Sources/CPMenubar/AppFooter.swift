import AppKit
import SwiftUI

// A menu bar app has no Dock icon, so there is no right-click → Quit and no window to close. Without
// this the only way out is `pkill`, which is not a thing to ask of anyone.
//
// Quitting the app does NOT stop a worker it started. The worker is its own process with its own
// state directory, exactly as one started from a launchd plist is — the app is a convenience over
// that contract, not its owner. Saying so here rather than leaving it to be discovered.
struct AppFooter: View {
    var body: some View {
        HStack {
            Spacer()
            Button(RunningWorker.shared.isOurs ? "Quit and stop the worker" : "Quit") {
                // Stops the worker this app started, and only that one. One started from a launchd
                // plist or by hand belongs to whoever started it and is left alone.
                RunningWorker.shared.stop()
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
            .help(RunningWorker.shared.isOurs
                ? "Stops the worker this app started, then quits."
                : "Quits this app. A worker started some other way is left running.")
        }
    }
}
