import AppKit

// The last question anybody gets to ask about a delete, put on the machine that holds the
// directory, because that is the only place the answer to "which directory" exists.
//
// The browser screen where the project was unticked cannot ask it. The socket never carries a
// path, and the one the server could infer from a heartbeat is matched by a looser rule than the
// one the app deletes by — a warning naming the wrong directory is worse than no warning (BP-378).
@MainActor
enum DeletionPrompt {
    static func ask(project: String, paths: [String]) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Delete this machine's checkout of \(project)?"
        alert.informativeText = """
            You unticked \(project) in the browser. Deleting removes, permanently:

            \(paths.joined(separator: "\n"))
            """
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Keep")
        // Return hits the first button by default, and here that key would be irreversible. Both
        // reflexes go to Keep instead, because this dialog arrives unasked and can land while
        // somebody is typing in another app.
        //
        // A button carries one key equivalent, so Keep takes Escape and is made the default cell
        // for Return. AppKit hands Escape out for free only to a button titled "Cancel", and
        // "Cancel" does not say what survives.
        alert.buttons.first?.keyEquivalent = ""
        alert.buttons.last?.keyEquivalent = "\u{1b}"
        if let keep = alert.buttons.last?.cell as? NSButtonCell {
            alert.window.defaultButtonCell = keep
        }
        // A menubar app with its popover shut has no window to put this in front of, and an alert
        // behind everything is a deletion that looks like a hang.
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }
}
