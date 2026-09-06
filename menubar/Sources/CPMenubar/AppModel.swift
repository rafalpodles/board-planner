import Foundation
import CPMenubarCore

@Observable
@MainActor
final class AppModel {
    private(set) var state = WorkerState()
    private(set) var config: ConfigResponse?

    private var client: SocketClient
    private let fixedClient: Bool
    private var pump: Task<Void, Never>?

    init(client: SocketClient? = nil) {
        self.client = client ?? AppModel.liveClient()
        self.fixedClient = client != nil
    }

    private static func liveClient() -> SocketClient {
        SocketClient(socketPath: SocketClient.defaultSocketPath(), transport: POSIXTransport())
    }

    func reconnect() {
        guard !fixedClient else { return }
        client = AppModel.liveClient()
        state = WorkerState()
        config = nil
        start()
    }

    func start() {
        pump?.cancel()
        pump = Task { await self.pumpForever() }
    }

    func stop() {
        pump?.cancel()
        pump = nil
    }

    private func pumpForever() async {
        while !Task.isCancelled {
            do {
                let status = try await client.status()
                state.adopt(status, at: Date())
                config = try? await client.config()
                if let catalogue = config?.catalogue {
                    await ProjectSyncRunner.shared.sync(
                        catalogue: catalogue,
                        isBusy: SyncPass.busy(asking: { [client] in try await client.status() }))
                }
                for await event in client.stream() {
                    state.apply(event, at: Date())
                    Notifier.shared.handle(event)
                }
            } catch {}
            if Task.isCancelled { return }
            state.markDisconnected()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    func send(_ command: String) {
        Task { [client] in
            _ = try? await client.command(command)
        }
    }
}
