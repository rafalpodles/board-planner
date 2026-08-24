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
    // Owned by the app, not this pane: changing boards stops the worker and drops its credential,
    // and the panel behind this window has to come back as the first-run screen.
    var onboarding: OnboardingModel
    @State private var confirming = false

    var body: some View {
        Form {
            LabeledContent("Server") {
                HStack {
                    // The stored address, not the one the socket reports: after the switch there is
                    // no worker to report anything, and a dash there would read as a broken machine.
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
            // Said before it happens, because it ends whatever the worker is running — and a
            // credential is minted by one board and refused by every other, so it cannot be carried
            // across. The checkouts stay: a checkout is still a checkout, whichever board is asking.
            Text(
                "The worker stops and forgets the credential this board gave it, so anything running now ends. Your checkouts and their allowlist are left alone. You will be asked to approve this machine on the new board."
            )
        }
    }
}

// The identity every push and pull request acts as. Editable here and not only during onboarding,
// because `gh auth switch` is global machine state — the day this matters is the day somebody adds
// a second account to a machine that has been running fine for months.
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
                // Said plainly, because the point of pinning is that this machine stops following
                // `gh auth switch` — and that is invisible from the account name alone.
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
                // Named by project, because that is what the operator is adding. The folder picker
                // beside it stays for a checkout they already have — and for a repository no
                // project names yet.
                // The list of projects lives in the browser, where the person is signed in: ticking
                // one there may mean switching workers on for it, and that is an instance admin in
                // an interactive session — which this app, holding only the machine's credential,
                // is not and must not become.
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

            // What the machine did about the picking, one line each. A clone takes minutes and a
            // deletion cannot be undone, so neither gets to happen behind a spinner.
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
                case .failed(let project, let reason):
                    Text("\(project): \(reason)").font(.caption2).foregroundStyle(.red)
                }
            }
            if sync.running {
                Text("Setting up what you picked…").font(.caption2).foregroundStyle(.secondary)
            }

            Text(
                offers.isEmpty
                    // The empty menu is the question "where is my project" waiting to happen, so it
                    // answers it in the place where the answer would be
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

    // Opened rather than embedded, and with the worker's own id so the screen is about THIS
    // machine. The app knows the board's address from the worker it is already reading.
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

    // What the worker says this machine could serve and has no checkout of. The app asks nobody
    // else: it holds no board credential, and the worker is already answering this question.
    private var offers: [ProjectOffer] { model.config?.offers ?? [] }

    private func load() {
        do {
            paths = try file.read()
            error = nil
        } catch {
            self.error = "Could not read repos.json: \(error.localizedDescription)"
        }
    }

    // The same two steps onboarding takes for the first project — clone it, then grant it — with
    // the same refusal when the checkout cannot be pushed to.
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

        // Off the main actor: a clone of a large repository would otherwise freeze the window, and
        // the operator would be looking at a hung app rather than a running git.
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

    // A folder picker is the only way in, matching repos.ts: a path the operator did not choose
    // from disk is exactly what the allowlist exists to refuse.
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
            // One row per bound project: these settings describe a repository, so a machine serving
            // two projects genuinely has two answers.
            ForEach(model.config?.projects ?? [], id: \.project) { project in
                Section("Project \(project.project)") {
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
            // Here rather than in the panel footer, where it cost attention every time somebody
            // opened the panel to buy nothing after the first day. Preferences works as a home only
            // because it is reachable at any time — this control began life in the first-run view,
            // which is shown until setup finishes and never again, so it was offered exactly once,
            // before anything worked. Any transient location reintroduces that.
            //
            // On this pane specifically because the state directory below explains what a login-item
            // launch does to the environment, which is the same fact from the other side.
            // Swift 6.3.3 quirk: passing `setLoginItem` here as a method reference crashes IRGen
            // emitting the actor-hopping thunk. The closure is not style.
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
        // Re-read rather than trust the last value: this can also be changed in System Settings
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
        // From the system, not from what was asked for — registering can land on "requires approval",
        // and the toggle then has to go back rather than claim something that did not happen
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
