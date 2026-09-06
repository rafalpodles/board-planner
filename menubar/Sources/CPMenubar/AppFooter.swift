import AppKit
import SwiftUI

struct AppFooter: View {
    var body: some View {
        HStack {
            Spacer()

            Button(RunningWorker.shared.isOurs ? "Quit and stop the worker" : "Quit") {
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
