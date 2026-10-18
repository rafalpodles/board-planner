import Combine
import SwiftUI
import CPMenubarCore

struct PanelView: View {
    let model: AppModel

    @Environment(\.openSettings) private var openSettings
    @State private var now = Date()
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var health: Health { model.state.effectiveHealth(now: now) }
    private var summary: PanelSummary {
        model.state.panelSummary(now: now, pollSeconds: model.config.map { $0.pollIntervalMs / 1000 })
    }

    // A pause stops new claims and leaves a run already going to finish, so the run's own detail
    // follows `currentPhase`, not the health word.
    private var runInProgress: Bool { model.state.currentPhase != nil && health != .disconnected }

    var body: some View {
        let quota = model.state.lastQuota.flatMap { QuotaSummary($0, now: now) }
        return VStack(alignment: .leading, spacing: 0) {
            header

            VStack(alignment: .leading, spacing: 2) {
                Text(summary.headline).font(.system(size: 17, weight: .semibold))
                Text(summary.detail).font(.callout).foregroundStyle(.secondary)
            }
            .padding(.top, 14)

            if runInProgress, let stage = model.state.stageIndex {
                StageRail(stage: stage, labels: WorkerState.stageLabels).padding(.top, 14)
            }

            if runInProgress, !model.state.recentTools.isEmpty {
                ToolLog(tools: tools).padding(.top, 12)
            }

            note.padding(.top, health == .idle || health == .disconnected || health == .paused ? 0 : 12)

            if quota?.exhausted == true, let quota {
                NoteCard(text: "Usage limit reached\(quota.resets.map { ", \($0)" } ?? "").", tint: .orange)
                    .padding(.top, 12)
            }

            if health != .disconnected { tiles(quota).padding(.top, 12) }

            footer.padding(.top, 14)
        }
        .padding(16)
        .frame(width: 340)
        .onReceive(tick) { now = $0 }
    }

    private var header: some View {
        HStack(spacing: 10) {
            BrandMark(size: 30)
            VStack(alignment: .leading, spacing: 0) {
                Text("Board Planner").font(.system(size: 13, weight: .medium))
                if let line = machineLine {
                    Text(line).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            StatePill(text: summary.pill, color: pillColor)
        }
    }

    private var machineLine: String? {
        guard let config = model.config else { return nil }
        let host = URL(string: config.apiUrl)?.host ?? config.apiUrl
        return config.workerName.isEmpty ? host : "\(config.workerName) · \(host)"
    }

    private var pillColor: Color {
        switch health {
        case .working: Brand.blue
        case .needsHuman: .orange
        case .faulted: .red
        case .idle, .paused, .disconnected: .secondary
        }
    }

    private var tools: [ToolActivity] { Array(model.state.recentTools.prefix(3)) }

    @ViewBuilder
    private var note: some View {
        switch health {
        case .needsHuman:
            VStack(alignment: .leading, spacing: 8) {
                NoteCard(text: outcomeNote ?? "Read the task on the board, then decide what happens to it.", tint: .orange)
                if let url = taskURL {
                    Button { NSWorkspace.shared.open(url) } label: {
                        Label("Open \(model.state.currentTaskKey ?? "task")", systemImage: "arrow.up.right.square")
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        case .faulted:
            NoteCard(text: outcomeNote ?? "The worker could not run the task on this machine.", tint: .red)
        case .idle, .working, .paused, .disconnected:
            EmptyView()
        }
    }

    private var outcomeNote: String? {
        guard let detail = model.state.lastOutcome?.detail, !detail.isEmpty else { return nil }
        return detail
    }

    private var taskURL: URL? {
        guard let key = model.state.currentTaskKey, let api = model.config?.apiUrl else { return nil }
        return BoardURL.task(apiURL: api, key: key)
    }

    private func tiles(_ quota: QuotaSummary?) -> some View {
        HStack(spacing: 8) {
            MetricTile(label: "Merged today", value: "\(model.state.mergedToday)")
            if let quota, !quota.exhausted {
                MetricTile(label: quota.label, value: quota.value, detail: quota.resets)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 2) {
            Button {
                model.send(health == .paused ? "resume" : "pause")
            } label: {
                Label(health == .paused ? "Resume" : "Pause", systemImage: health == .paused ? "play.fill" : "pause.fill")
            }
            .buttonStyle(FooterButtonStyle())
            .opacity(health == .disconnected ? 0 : 1)
            .disabled(health == .disconnected)
            .accessibilityHidden(health == .disconnected)

            if model.state.currentPhase != nil && health != .disconnected {
                Button { model.send("stop") } label: {
                    Label { Text("Stop") } icon: { Image(systemName: "stop.fill").foregroundStyle(.red) }
                }
                .buttonStyle(FooterButtonStyle())
            }

            Spacer()

            // Two things are needed, not one. An LSUIElement app has no menu bar, so the Settings
            // scene is otherwise unreachable — and it runs as an accessory, so nothing activates it:
            // SettingsLink alone opens the window behind every other app, which reads as a dead
            // button. Activating first is what puts it in front.
            Button {
                NSApp.activate(ignoringOtherApps: true)
                openSettings()
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(FooterButtonStyle())
            .accessibilityLabel("Preferences")
            .help("Preferences")

            QuitButton()
        }
        .padding(.top, 10)
        .overlay(alignment: .top) { Divider() }
    }
}
