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
