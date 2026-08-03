import Foundation
import CPMenubarCore

@Observable
@MainActor
final class AppModel {
    private(set) var state = WorkerState()
    private(set) var config: ConfigResponse?

    private let client: SocketClient
    private var pump: Task<Void, Never>?

    init(
        client: SocketClient = SocketClient(
            socketPath: SocketClient.defaultSocketPath(),
            transport: NWTransport())
    ) {
        self.client = client
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
                state.adopt(try await client.status(), at: Date())
                config = try? await client.config()
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
