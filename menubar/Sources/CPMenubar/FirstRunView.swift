import AppKit
import SwiftUI
import CPMenubarCore

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
            if onboarding.githubAccounts.count > 1 { githubAccount }
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
            TextField("your-board.example.com or localhost:3000", text: $onboarding.apiURL)
                .textFieldStyle(.roundedBorder)
            TextField("This machine's name", text: $onboarding.workerName)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var checkout: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("2 · Where it keeps its checkouts").font(.subheadline).bold()
            HStack {
                Text(onboarding.state.checkoutsFolder.isEmpty ? "No folder chosen" : onboarding.state.checkoutsFolder)
                    .font(.caption).lineLimit(1).truncationMode(.head)
                Spacer()
                Button("Choose…") { chooseFolder() }
            }
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
                        Text(check.detail).font(.caption2).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private var githubAccount: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Which GitHub account it pushes as").font(.subheadline).bold()
            Picker("", selection: accountBinding) {
                Text("Whichever gh has active").tag("")
                ForEach(onboarding.githubAccounts) { account in
                    Text(account.login).tag(account.login)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            Text(
                "gh holds \(onboarding.githubAccounts.count) accounts, and any terminal can switch them. Naming one here keeps this machine pushing as that account whatever else happens on it."
            )
            .font(.caption2).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var accountBinding: Binding<String> {
        Binding(
            get: { onboarding.pinnedGithubAccount },
            set: { onboarding.pinGithubAccount($0) })
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
                if !onboarding.state.checkoutPath.isEmpty {
                    Text("Working in \(onboarding.state.checkoutPath)")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                }
                Text(LoginItem.statusDescription).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Start again") { onboarding.startAgain() }
                }
            }
        default:
            HStack {
                Button("Check this machine") {
                    onboarding.runPreflight(checkout: onboarding.state.checkoutsFolder)
                }
                .disabled(onboarding.state.checkoutsFolder.isEmpty || onboarding.busy)

                Button("Connect") { onboarding.connect() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canConnect)
            }
        }
    }

    private var canConnect: Bool {
        !onboarding.busy
            && !onboarding.apiURL.isEmpty
            && !onboarding.state.checkoutsFolder.isEmpty
            && onboarding.preflight?.ok == true
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.message = "Choose the folder where this machine keeps its checkouts. The worker clones its own copy inside it."
        panel.prompt = "Keep checkouts here"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        onboarding.chooseFolder(url.path)
    }
}
