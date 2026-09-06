import AppKit
import SwiftUI
import CPMenubarCore

struct PreferencesView: View {
    let model: AppModel
    var onboarding: OnboardingModel

    var body: some View {
        TabView {
            ConnectionTab(model: model, onboarding: onboarding)
                .tabItem { Label("Connection", systemImage: "network") }
            RepositoriesTab(model: model)
                .tabItem { Label("Repositories", systemImage: "folder") }
            PolicyTab(model: model)
                .tabItem { Label("Policy", systemImage: "slider.horizontal.3") }
            AdvancedTab(model: model)
                .tabItem { Label("Advanced", systemImage: "gearshape") }
        }
        .frame(width: 460, height: 320)
    }
}

private struct ConnectionTab: View {
    let model: AppModel
    var onboarding: OnboardingModel
    @State private var confirming = false

    var body: some View {
        Form {
            LabeledContent("Server") {
                HStack {
                    Text(model.config?.apiUrl ?? onboarding.state.apiURL).lineLimit(1).truncationMode(.head)
                    Button("Change…") { confirming = true }
                }
            }
            LabeledContent("Worker", value: model.config?.workerName ?? "—")
            LabeledContent("Projects", value: model.config.map { "\($0.projectCount)" } ?? "—")
            GithubAccountRow(accounts: model.config?.githubAccounts ?? [])
            Text("This app reads the worker over a local socket and holds no credential of its own. "
                 + "Registration is done on the worker.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .padding()
        .confirmationDialog(
            "Connect this machine to a different board?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("Change board", role: .destructive) { onboarding.changeBoard() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "The worker stops and forgets the credential this board gave it, so anything running now ends. Your checkouts and their allowlist are left alone. You will be asked to approve this machine on the new board."
            )
        }
    }
}

private struct GithubAccountRow: View {
    let accounts: [GithubAccountChoice]
    @State private var pinned = (try? GithubAccountFile(path: GithubAccountFile.defaultPath()).read()) ?? ""
    @State private var error = ""

    var body: some View {
        Group {
            if accounts.isEmpty {
                LabeledContent("GitHub", value: "—")
            } else {
                Picker("GitHub", selection: binding) {
                    Text("Whichever gh has active").tag("")
                    ForEach(accounts) { account in
                        Text(account.login).tag(account.login)
                    }
                }
            }
            if !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(.red)
            } else if !pinned.isEmpty {
                Text("Pushes act as \(pinned) whatever gh is switched to. It takes effect on the next task; a run already in flight keeps the identity it started with.")
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var binding: Binding<String> {
        Binding(
            get: { pinned },
            set: { login in
                do {
                    try GithubAccountFile(path: GithubAccountFile.defaultPath()).write(login)
                    pinned = login
                    error = ""
                } catch {
                    self.error = "Could not write the GitHub account: \(error.localizedDescription)"
                }
            })
    }
}

private struct RepositoriesTab: View {
    let model: AppModel

    @State private var paths: [String] = []
    @State private var selection: String?
    @State private var error: String?
    @State private var note = ""
    @State private var busy = false

    private let file = ReposFile(path: ReposFile.defaultPath())
    private var sync: ProjectSyncRunner { ProjectSyncRunner.shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            List(paths, id: \.self, selection: $selection) { path in
                Text(path).lineLimit(1).truncationMode(.head)
            }

            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }

            HStack {
                Button("Choose projects…") { openPicker() }
                    .disabled(model.config == nil)

                Menu("Add from board…") {
                    ForEach(offers) { offer in
                        Button(offer.label) { addFromBoard(offer) }
                    }
                }
                .disabled(offers.isEmpty || busy)
                .frame(width: 150)

                Button("Add…") { add() }
                Button("Remove") { remove() }.disabled(selection == nil)
                Spacer()
            }

            if !note.isEmpty {
                Text(note).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ForEach(Array(sync.steps.enumerated()), id: \.offset) { _, step in
                switch step {
                case .added(let project, let path):
                    Text("Set up \(project) in \(path)").font(.caption2).foregroundStyle(.secondary)
                case .removed(let project, let path):
                    Text("Removed \(project) — deleted \(path)").font(.caption2).foregroundStyle(.secondary)
                case .forgotten(let project, let path):
                    Text("Dropped \(project) — \(path) was already gone")
                        .font(.caption2).foregroundStyle(.secondary)
                case .refused(let project, let reason):
                    Text("Left \(project) alone: \(reason)").font(.caption2).foregroundStyle(.orange)
                case .partiallyRemoved(let project, let removed, let reason):
                    Text("\(project): stopped after deleting \(removed.joined(separator: ", ")) — \(reason)")
                        .font(.caption2).foregroundStyle(.red)
                case .failed(let project, let reason):
                    Text("\(project): \(reason)").font(.caption2).foregroundStyle(.red)
                }
            }
            if sync.running {
                Text("Setting up what you picked…").font(.caption2).foregroundStyle(.secondary)
            }

            Text(
                offers.isEmpty
                    ? "The worker only ever binds a repository listed here. A project joins this list once workers are enabled on it and it names a repository — and drops off it again once this machine has its checkout."
                    : "The worker only ever binds a repository listed here."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding()
        .onAppear(perform: load)
    }

    private func openPicker() {
        guard let config = model.config else { return }
        let board = BoardURL.normalise(config.apiUrl)
        let workerId = (try? IdentityFile(path: IdentityFile.defaultPath()).read())?.workerId ?? ""
        guard !workerId.isEmpty, let url = URL(string: "\(board)/settings/workers/\(workerId)/projects")
        else {
            error = "This machine has no identity yet, so there is no list to show."
            return
        }
        NSWorkspace.shared.open(url)
    }

    private var offers: [ProjectOffer] { model.config?.offers ?? [] }

    private func load() {
        do {
            paths = try file.read()
            error = nil
        } catch {
            self.error = "Could not read repos.json: \(error.localizedDescription)"
        }
    }

    private func addFromBoard(_ offer: ProjectOffer) {
        let state = Onboarding.load()
        guard !state.checkoutsFolder.isEmpty else {
            error = "This machine has no checkouts folder yet. Finish connecting it first."
            return
        }

        busy = true
        note = "Cloning \(offer.repositoryUrl)…"
        error = nil

        let setup = ProjectSetup(
            clone: WorkerProcess.cloneStep(
                toolPath: state.toolPath,
                githubToken: WorkerProcess.githubToken(
                    account: (try? GithubAccountFile(path: GithubAccountFile.defaultPath()).read()) ?? "",
                    toolPath: state.toolPath)),
            repos: file)

        Task.detached {
            let result = setup.add(offer, parent: state.checkoutsFolder)
            await MainActor.run {
                busy = false
                switch result {
                case .success(let path):
                    note = "\(offer.label) is set up in \(path). The worker picks it up on its next poll."
                    load()
                case .failure(.clone(let reason)), .failure(.grant(let reason)):
                    note = ""
                    error = reason
                }
            }
        }
    }

    private func add() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let path = panel.url?.path else { return }
        save(paths.contains(path) ? paths : paths + [path])
    }

    private func remove() {
        guard let selection else { return }
        save(paths.filter { $0 != selection })
    }

    private func save(_ next: [String]) {
        do {
            try file.write(next)
            paths = next
            selection = nil
            error = nil
        } catch {
            self.error = "Could not write repos.json: \(error.localizedDescription)"
        }
    }
}

private struct PolicyTab: View {
    let model: AppModel

    var body: some View {
        Form {
            ForEach(model.config?.projects ?? [], id: \.project) { project in
                Section("Project \(project.project)") {
                    if let blocked = project.blocked, !blocked.isEmpty {
                        Text("Not claiming: \(blocked)").font(.caption).foregroundStyle(.orange)
                    }
                    LabeledContent("Base branch", value: project.baseBranch)
                    LabeledContent("Model", value: project.model)
                    LabeledContent("Review model", value: project.reviewModel)
                    LabeledContent("Max diff lines", value: "\(project.maxDiffLines)")
                }
            }
            if model.config?.projects.isEmpty ?? true {
                Text("No project bound yet.").foregroundStyle(.secondary)
            }
            Text("These come from each project's own settings — Settings → Workers on that project.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct AdvancedTab: View {
    let model: AppModel

    @State private var stateDirectory = StateDirectory.resolve()
    @State private var startsAtLogin = LoginItem.isRegistered
    @State private var loginItemNote = ""

    var body: some View {
        Form {
            Toggle("Start at login", isOn: Binding(get: { startsAtLogin }, set: { setLoginItem($0) }))
                .help("Opens this app when you log in, which starts the worker with it.")
            if !loginItemNote.isEmpty {
                Text(loginItemNote).font(.caption).foregroundStyle(.secondary)
            }

            LabeledContent("Task timeout",
                           value: model.config?.projects.first.map { "\($0.taskTimeoutMs / 1000)s" } ?? "—")

            LabeledContent("State directory") {
                HStack {
                    Text(stateDirectory).lineLimit(1).truncationMode(.head)
                    Button("Choose…") { choose() }
                }
            }
            LabeledContent("Socket", value: SocketClient.socketPath(in: stateDirectory))
            LabeledContent("Allowlist", value: ReposFile.path(in: stateDirectory))

            Text("Where the worker keeps its socket. Launched from Finder or a login item this app "
                 + "inherits no environment, so CP_STATE_DIR is not visible to it — set it here.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .padding()
        .onAppear { startsAtLogin = LoginItem.isRegistered }
    }

    private func setLoginItem(_ wanted: Bool) {
        do {
            if wanted {
                try LoginItem.register()
            } else {
                try LoginItem.unregister()
            }
            loginItemNote = LoginItem.statusDescription
        } catch {
            loginItemNote = error.localizedDescription
        }
        startsAtLogin = LoginItem.isRegistered
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: stateDirectory)
        guard panel.runModal() == .OK, let path = panel.url?.path else { return }
        StateDirectory.set(path)
        stateDirectory = path
        model.reconnect()
    }
}
