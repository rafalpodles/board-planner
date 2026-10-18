import AppKit
import SwiftUI
import CPMenubarCore

// What an app with no identity offers instead of "Can't reach the worker": the three things that
// have to happen, in order, with the one that failed saying why.
struct FirstRunView: View {
    @Bindable var onboarding: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch onboarding.state.step {
            case .awaitingApproval where !onboarding.state.userCode.isEmpty:
                approve
            case .starting:
                settingUp
            default:
                setup
            }

            if !onboarding.message.isEmpty, onboarding.state.step != .starting {
                Text(onboarding.message)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
            }

            AppFooter()
                .padding(.top, 12)
                .overlay(alignment: .top) { Divider() }
                .padding(.top, 14)
        }
        .padding(16)
        .frame(width: 380)
    }

    private func header(_ title: String, _ subtitle: String) -> some View {
        HStack(spacing: 10) {
            BrandMark(size: 30)
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(.system(size: 16, weight: .semibold))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.bottom, 16)
    }

    // MARK: Setup

    private var setup: some View {
        VStack(alignment: .leading, spacing: 0) {
            header("Connect this Mac", "A worker runs approved tasks here and reports back to the board.")

            StepHeader(number: 1, title: "Board", done: !onboarding.apiURL.trimmingCharacters(in: .whitespaces).isEmpty)
            VStack(alignment: .leading, spacing: 6) {
                TextField("your-board.example.com or localhost:3000", text: $onboarding.apiURL)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Board address")
                HStack(spacing: 8) {
                    Text("Name").font(.caption).foregroundStyle(.secondary).frame(width: 34, alignment: .leading)
                    TextField("This machine's name", text: $onboarding.workerName)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Machine name")
                }
            }
            .padding(.bottom, 14)

            StepHeader(number: 2, title: "Checkouts folder", done: !onboarding.state.checkoutsFolder.isEmpty && onboarding.repositoryProblems.isEmpty)
            HStack {
                Text(onboarding.state.checkoutsFolder.isEmpty ? "No folder chosen" : onboarding.state.checkoutsFolder)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(onboarding.state.checkoutsFolder.isEmpty ? .secondary : .primary)
                    .lineLimit(1).truncationMode(.head)
                Spacer()
                Button("Choose…") { chooseFolder() }
            }
            // Refused at the picker, with the fix, rather than as a string in the fleet console
            // after this machine has already been enrolled
            ForEach(onboarding.repositoryProblems, id: \.summary) { problem in
                VStack(alignment: .leading, spacing: 1) {
                    Text(problem.summary).font(.caption).foregroundStyle(.red)
                    Text(problem.fix).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.top, 4)
            }
            Spacer().frame(height: 14)

            if let report = onboarding.preflight {
                machine(report)
            } else {
                StepHeader(number: 3, title: "This machine", done: false)
                Text("Checks that git, npm, claude and gh are here and signed in.")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.bottom, 14)
            }

            if onboarding.githubAccounts.count > 1 { githubAccount.padding(.bottom, 14) }

            actions
        }
    }

    private func machine(_ report: PreflightReport) -> some View {
        let failing = report.checks.filter { !$0.ok }
        let passing = report.checks.filter(\.ok)
        return VStack(alignment: .leading, spacing: 8) {
            StepHeader(number: 3, title: "This machine", done: failing.isEmpty)
            ForEach(failing) { check in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(check.name).font(.callout.weight(.medium))
                        // Already a plain sentence with the fix in it, written once in the worker
                        Text(check.detail).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityElement(children: .combine)
                .accessibilityValue("failed")
            }
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(passing) { check in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "checkmark.circle").foregroundStyle(.green)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(check.name).font(.caption.weight(.medium))
                                Text(check.detail).font(.caption).foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(.top, 6)
            } label: {
                Text("\(passing.count) of \(report.checks.count) checks passed")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(.bottom, 14)
    }

    // Offered only where there is a choice to make. On a machine with one account the row would be
    // a picker with one entry, which is a decision nobody has.
    private var githubAccount: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Pushes as").font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Picker("", selection: accountBinding) {
                // Not the same as picking the account that happens to be active today: this one
                // follows `gh auth switch`, and the named ones deliberately do not.
                Text("Whichever gh has active").tag("")
                ForEach(onboarding.githubAccounts) { account in
                    Text(account.login).tag(account.login)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            Text(
                "gh holds \(onboarding.githubAccounts.count) accounts. Naming one keeps this machine pushing as it, whatever a terminal switches to."
            )
            .font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var accountBinding: Binding<String> {
        Binding(
            get: { onboarding.pinnedGithubAccount },
            set: { onboarding.pinGithubAccount($0) })
    }

    private var blocker: String? {
        ConnectReadiness.blocker(
            apiURL: onboarding.apiURL,
            checkoutsFolder: onboarding.state.checkoutsFolder,
            preflightRan: onboarding.preflight != nil,
            failingChecks: onboarding.preflight?.checks.filter { !$0.ok }.map(\.name) ?? [],
            busy: onboarding.busy)
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(blocker ?? "Everything this worker needs is here.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer()
                Button("Check this machine") {
                    onboarding.runPreflight(checkout: onboarding.state.checkoutsFolder)
                }
                .disabled(onboarding.state.checkoutsFolder.isEmpty || onboarding.busy)

                Button("Connect") { onboarding.connect() }
                    .buttonStyle(.borderedProminent)
                    .tint(Brand.actionBlue)
                    .disabled(blocker != nil)
            }
        }
    }

    // MARK: Approve

    private var approve: some View {
        VStack(alignment: .leading, spacing: 0) {
            header("Approve this Mac", "Confirm the code on the page that just opened.")

            Text(onboarding.state.userCode)
                .font(.system(size: 26, weight: .medium, design: .monospaced))
                .tracking(3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("Code \(onboarding.state.userCode.map(String.init).joined(separator: " "))")

            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Waiting for you to approve it on \(host)…").font(.callout).foregroundStyle(.secondary)
            }
            .padding(.vertical, 12)

            HStack {
                Spacer()
                Button("Open the page again") {
                    if let url = URL(string: onboarding.state.verificationURL) { NSWorkspace.shared.open(url) }
                }
            }
        }
    }

    private var host: String {
        let board = BoardURL.normalise(onboarding.apiURL)
        return URL(string: board)?.host ?? board
    }

    // MARK: Setting up

    // The enrolment is approved and the worker is not running yet: the clone, the push check, then
    // the start. A failure keeps the credential and says why. A relaunch in this step, or a
    // preflight rerun after a failure, has neither a clone in flight nor a reason to show: that is
    // an unfinished setup, and it offers the same way out rather than a spinner nobody is turning.
    private var settingUp: some View {
        let failure = onboarding.setupFailure
        let working = onboarding.busy && failure == nil
        return VStack(alignment: .leading, spacing: 0) {
            header("Setting up this Mac", "This takes a minute the first time.")

            VStack(spacing: 0) {
                SetupRow(title: "Registered with the board", state: .done)
                Divider()
                SetupRow(
                    title: "Cloning the repository and checking it can push",
                    state: failure?.stage == .cloning ? .failed
                        : failure?.stage == .starting ? .done
                        : working ? .active : .unfinished)
                Divider()
                SetupRow(
                    title: "Starting the worker",
                    state: failure?.stage == .starting ? .failed : .pending)
            }
            .padding(.horizontal, 12)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))

            if let failure {
                Text(failure.reason)
                    .font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
            } else if working, !onboarding.message.isEmpty {
                Text(onboarding.message)
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
            } else if !working {
                Text("Setup did not finish. Connect again to retry; your checkouts folder and machine checks are kept.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
            }

            if !onboarding.busy { HStack { Spacer(); retryActions }.padding(.top, 10) }
        }
    }

    private var retryActions: some View {
        HStack(spacing: 8) {
            Button("Check this machine") {
                onboarding.runPreflight(checkout: onboarding.state.checkoutsFolder)
            }
            .disabled(onboarding.state.checkoutsFolder.isEmpty)
            Button("Connect") { onboarding.connect() }
                .buttonStyle(.borderedProminent)
                .tint(Brand.actionBlue)
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        // NSOpenPanel hides this by default, unlike NSSavePanel — so someone who has not already
        // made the folder has nowhere to go but Finder and back
        panel.canCreateDirectories = true
        panel.message = "Choose the folder where this machine keeps its checkouts. The worker clones its own copy inside it."
        panel.prompt = "Keep checkouts here"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        onboarding.chooseFolder(url.path)
    }
}

private struct StepHeader: View {
    let number: Int
    let title: String
    let done: Bool

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                Circle().fill(done ? Color.green.opacity(0.18) : Color.secondary.opacity(0.15)).frame(width: 18, height: 18)
                if done {
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.green)
                } else {
                    Text("\(number)").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary)
        }
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
    }
}

private struct SetupRow: View {
    enum RowState { case done, active, pending, failed, unfinished }
    let title: String
    let state: RowState

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.callout).foregroundStyle(state == .pending ? .secondary : .primary)
            Spacer()
            switch state {
            case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case .active: ProgressView().controlSize(.small)
            case .pending: Text("Next").font(.caption).foregroundStyle(.secondary)
            case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
            case .unfinished: Text("Not finished").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 34)
        .accessibilityElement(children: .combine)
        .accessibilityValue(accessibilityState)
    }

    private var accessibilityState: String {
        switch state {
        case .done: "done"
        case .active: "in progress"
        case .pending: "not started"
        case .failed: "failed"
        case .unfinished: "not finished"
        }
    }
}
