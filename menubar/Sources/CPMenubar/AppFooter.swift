import AppKit
import SwiftUI

// A menu bar app has no Dock icon, so there is no right-click → Quit and no window to close. Without
// this the only way out is `pkill`, which is not a thing to ask of anyone. That is why this strip
// renders on every screen, and why quitting is the only thing left on it.
struct AppFooter: View {
    var body: some View {
        HStack {
            Spacer()

            Button(RunningWorker.shared.isOurs ? "Quit and stop the worker" : "Quit") {
                // Stops the worker this app started, and only that one. One started from a
                // launchd plist or by hand belongs to whoever started it and is left alone.
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
