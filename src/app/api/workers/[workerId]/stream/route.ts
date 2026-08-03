import { NextResponse } from "next/server";
import { withWorker } from "@/lib/middleware";
import { registerWorkerStream, unregisterWorkerStream } from "@/lib/worker-events";

const PING_MS = 15_000;

export const GET = withWorker(async (_request, { worker }) => {
  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run" }, { status: 403 });
  }

  const workerId = String(worker._id);
  const encoder = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      registerWorkerStream(workerId, controller);
      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          if (ping) clearInterval(ping);
          unregisterWorkerStream(workerId, controller);
        }
      }, PING_MS);
    },
    cancel() {
      if (ping) clearInterval(ping);
      if (streamController) unregisterWorkerStream(workerId, streamController);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
