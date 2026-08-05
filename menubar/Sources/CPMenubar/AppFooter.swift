import AppKit
import SwiftUI

// A menu bar app has no Dock icon, so there is no right-click → Quit and no window to close. Without
// this the only way out is `pkill`, which is not a thing to ask of anyone.
//
// Both controls live here because this is the one strip that renders on every screen. "Start at
// login" used to sit in the first-run view alone, which is shown only until setup finishes — so it
// was offered exactly once, before anything worked, and was unreachable forever after.
struct AppFooter: View {
    @State private var startsAtLogin = LoginItem.isRegistered
    @State private var note = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !note.isEmpty {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                Button(startsAtLogin ? "Don't start at login" : "Start at login") {
                    toggleLoginItem()
                }
                .help(startsAtLogin
                    ? "Stops this app — and the worker it starts — from opening when you log in."
                    : "Opens this app when you log in, which starts the worker with it.")

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
        // Re-read rather than trust the last value: this can also be changed in System Settings
        .onAppear { startsAtLogin = LoginItem.isRegistered }
    }

    private func toggleLoginItem() {
        do {
            if startsAtLogin {
                try LoginItem.unregister()
            } else {
                try LoginItem.register()
            }
            note = LoginItem.statusDescription
        } catch {
            note = error.localizedDescription
        }
        // From the system, not from what was asked for — registering can land on "requires approval"
        startsAtLogin = LoginItem.isRegistered
    }
}
