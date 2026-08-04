import AppKit
import SwiftUI
import CPMenubarCore

struct PreferencesView: View {
    let model: AppModel

    var body: some View {
        TabView {
            ConnectionTab(model: model)
                .tabItem { Label("Connection", systemImage: "network") }
            RepositoriesTab()
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

    var body: some View {
        Form {
            LabeledContent("Server", value: model.config?.apiUrl ?? "—")
            LabeledContent("Worker", value: model.config?.workerName ?? "—")
            LabeledContent("Projects", value: model.config.map { "\($0.projectCount)" } ?? "—")
            Text("This app reads the worker over a local socket and holds no credential of its own. "
                 + "Registration is done on the worker.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct RepositoriesTab: View {
    @State private var paths: [String] = []
    @State private var selection: String?
    @State private var error: String?

    private let file = ReposFile(path: ReposFile.defaultPath())

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            List(paths, id: \.self, selection: $selection) { path in
                Text(path).lineLimit(1).truncationMode(.head)
            }

            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }

            HStack {
                Button("Add…") { add() }
                Button("Remove") { remove() }.disabled(selection == nil)
                Spacer()
            }

            Text("The worker only ever binds a repository listed here.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .onAppear(perform: load)
    }

    private func load() {
        do {
            paths = try file.read()
            error = nil
        } catch {
            self.error = "Could not read repos.json: \(error.localizedDescription)"
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
                    LabeledContent("Merges automatically", value: project.autoMerge ? "yes" : "no")
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

    var body: some View {
        Form {
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
