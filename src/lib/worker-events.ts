// Keyed by worker id, one controller per open stream, living in this process's memory only. On
// more than one Railway replica, a command published while the worker's stream is open on a
// different replica never reaches this map — the heartbeat (which already carries `command`) is
// therefore the contract, and this map is only an accelerator for a worker connected to the
// replica handling the command request.
const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

export function registerWorkerStream(
  workerId: string,
  controller: ReadableStreamDefaultController<Uint8Array>
): void {
  streams.set(workerId, controller);
}

export function unregisterWorkerStream(
  workerId: string,
  controller: ReadableStreamDefaultController<Uint8Array>
): void {
  // A stale close from a superseded connection must not evict the newer one
  if (streams.get(workerId) === controller) streams.delete(workerId);
}

export function publishToWorker(
  workerId: string,
  event: { command: string; commandIssuedAt?: string }
): void {
  const controller = streams.get(workerId);
  if (!controller) return;
  try {
    controller.enqueue(new TextEncoder().encode(`event: command\ndata: ${JSON.stringify(event)}\n\n`));
  } catch {
    streams.delete(workerId);
  }
}
