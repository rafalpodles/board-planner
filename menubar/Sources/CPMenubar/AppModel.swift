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

    // Pointing the app at another state directory has to take effect without a relaunch, since the
    // operator has just been told that is where the socket lives.
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

    // A worker restart drops the socket; reconnecting on our own is what makes "retrying" true
    // rather than decorative.
    private func pumpForever() async {
        while !Task.isCancelled {
            do {
                let status = try await client.status()
                state.adopt(status, at: Date())
                config = try? await client.config()
                // The picking happens in a browser; this is where the machine catches up with it.
                // The runner is handed the question rather than an answer, because a clone takes
                // minutes and the answer would be stale by the time a deletion acts on it.
                //
                // A socket that will not answer counts as busy — SyncPass.busy(asking:) states why,
                // and is where that rule is tested.
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
