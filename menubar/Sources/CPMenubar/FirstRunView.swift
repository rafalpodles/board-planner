import AppKit
import SwiftUI
import CPMenubarCore

// What an app with no identity offers instead of "Can't reach the worker": the three things that
// have to happen, in order, with the one that failed saying why.
struct FirstRunView: View {
    @Bindable var onboarding: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Connect this Mac").font(.headline)
            Text("A worker runs approved tasks here and reports back to the board.")
                .font(.caption).foregroundStyle(.secondary)

            Divider()

            server
            checkout
            if onboarding.preflight != nil { preflightSummary }
            connect

            if !onboarding.message.isEmpty {
                Text(onboarding.message).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            AppFooter()
        }
        .padding(14)
        .frame(width: 380)
    }

    private var server: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("1 · Where the board lives").font(.subheadline).bold()
            TextField("https://your-board.example.com", text: $onboarding.apiURL)
                .textFieldStyle(.roundedBorder)
            TextField("This machine's name", text: $onboarding.workerName)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var checkout: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("2 · Which checkout it may use").font(.subheadline).bold()
            HStack {
                Text(onboarding.state.checkoutPath.isEmpty ? "No folder chosen" : onboarding.state.checkoutPath)
                    .font(.caption).lineLimit(1).truncationMode(.head)
                Spacer()
                Button("Choose…") { chooseFolder() }
            }
            // Refused at the picker, with the fix, rather than as a string in the fleet console
            // after this machine has already been enrolled
            ForEach(onboarding.repositoryProblems, id: \.summary) { problem in
                VStack(alignment: .leading, spacing: 1) {
                    Text(problem.summary).font(.caption).foregroundStyle(.red)
                    Text(problem.fix).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var preflightSummary: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("3 · What this machine has").font(.subheadline).bold()
            ForEach(onboarding.preflight?.checks ?? []) { check in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: check.ok ? "checkmark.circle" : "xmark.circle")
                        .foregroundStyle(check.ok ? .green : .red)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(check.name).font(.caption).bold()
                        // Already a plain sentence with the fix in it, written once in the worker
                        Text(check.detail).font(.caption2).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var connect: some View {
        Divider()
        switch onboarding.state.step {
        case .awaitingApproval where !onboarding.state.userCode.isEmpty:
            VStack(alignment: .leading, spacing: 4) {
                Text("Approve it in the browser").font(.subheadline).bold()
                Text("It should show this code:").font(.caption).foregroundStyle(.secondary)
                Text(onboarding.state.userCode).font(.system(.title3, design: .monospaced))
                Button("Open the page again") {
                    if let url = URL(string: onboarding.state.verificationURL) {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        case .running:
            VStack(alignment: .leading, spacing: 6) {
                Label("Connected and running", systemImage: "checkmark.seal")
                Text(LoginItem.statusDescription).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Start at login") { onboarding.registerLoginItem() }
                    Button("Start again") { onboarding.startAgain() }
                }
            }
        default:
            HStack {
                Button("Check this machine") {
                    onboarding.runPreflight(checkout: onboarding.state.checkoutPath)
                }
                .disabled(onboarding.state.checkoutPath.isEmpty || onboarding.busy)

                Button("Connect") { onboarding.connect() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canConnect)
            }
        }
    }

    private var canConnect: Bool {
        !onboarding.busy
            && !onboarding.apiURL.isEmpty
            && !onboarding.state.checkoutPath.isEmpty
            && onboarding.preflight?.ok == true
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Use this checkout"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        onboarding.chooseFolder(url.path)
    }
}
