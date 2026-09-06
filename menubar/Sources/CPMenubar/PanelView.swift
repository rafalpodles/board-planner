import Combine
import SwiftUI
import CPMenubarCore

struct PanelView: View {
    let model: AppModel

    @Environment(\.openSettings) private var openSettings
    @State private var now = Date()
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            if model.state.currentPhase != nil {
                stepper
            }

            if !model.state.recentTools.isEmpty {
                Divider()
                tools
            }

            Divider()
            controls

            Text("\(model.state.mergedToday) merged today")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()
            AppFooter()
        }
        .padding(14)
        .frame(width: 320)
        .onReceive(tick) { now = $0 }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(headline).font(.headline)
            if let quota = model.state.lastQuota, quota.status != "allowed" {
                Text(quotaNote(quota)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var stepper: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(model.state.stepperRows(), id: \.phase) { row in
                Label(row.phase, systemImage: symbol(for: row.state))
                    .foregroundStyle(row.state == .pending ? .secondary : .primary)
            }
        }
        .font(.callout)
    }

    private var tools: some View {
        ForEach(Array(model.state.recentTools.enumerated()), id: \.offset) { _, tool in
            Text(tool.target.map { "\(tool.name) · \($0)" } ?? tool.name)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var controls: some View {
        HStack {
            Button(model.state.health == .paused ? "Resume" : "Pause") {
                model.send(model.state.health == .paused ? "resume" : "pause")
            }
            .disabled(model.state.health == .disconnected)

            Button("Stop") { model.send("stop") }
                .disabled(model.state.currentPhase == nil)

            Spacer()

            Button("Preferences…") {
                NSApp.activate(ignoringOtherApps: true)
                openSettings()
            }
        }
    }

    private var headline: String {
        switch model.state.health {
        case .idle: return "Waiting for work"
        case .working: return model.state.title(now: now) ?? "Working"
        case .paused: return "Paused"
        case .needsHuman: return "Needs a human"
        case .disconnected: return "Can't reach the worker · retrying"
        }
    }

    private func quotaNote(_ quota: Quota) -> String {
        quota.status == "rejected"
            ? "Usage limit reached"
            : "Usage at \(Int((quota.utilization ?? 0) * 100))%"
    }

    private func symbol(for state: StepState) -> String {
        switch state {
        case .done: return "checkmark.circle.fill"
        case .active: return "circle.dotted"
        case .pending: return "circle"
        }
    }
}
