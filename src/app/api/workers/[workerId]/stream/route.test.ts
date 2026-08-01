import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const registerWorkerStream = vi.fn();
const unregisterWorkerStream = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, verifyWorkerCredential };
});
vi.mock("@/lib/worker-events", () => ({ registerWorkerStream, unregisterWorkerStream }));

const { GET } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: WORKER_ID,
    enabled: true,
    lockedByInstance: false,
    credentialHash: "irrelevant-once-verified",
    ...overrides,
  };
}

function request() {
  return new Request(`http://localhost/api/workers/${WORKER_ID}/stream`, {
    headers: { authorization: "Bearer cpw_secret", "x-worker-id": WORKER_ID },
  });
}

function ctx() {
  return { params: Promise.resolve({ workerId: WORKER_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  verifyWorkerCredential.mockResolvedValue(workerDoc());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/workers/:workerId/stream", () => {
  it("403s a disabled worker without opening a stream", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ enabled: false }));

    const response = await GET(request(), ctx());

    expect(response.status).toBe(403);
    expect(registerWorkerStream).not.toHaveBeenCalled();
  });

  it("403s an instance-locked worker without opening a stream", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ lockedByInstance: true }));

    const response = await GET(request(), ctx());

    expect(response.status).toBe(403);
    expect(registerWorkerStream).not.toHaveBeenCalled();
  });

  it("401s without a worker credential — the ownership check never runs", async () => {
    const response = await GET(new Request(`http://localhost/api/workers/${WORKER_ID}/stream`), ctx());

    expect(response.status).toBe(401);
    expect(registerWorkerStream).not.toHaveBeenCalled();
  });

  it("opens an SSE stream and registers it, keyed by the worker's own id", async () => {
    const response = await GET(request(), ctx());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(registerWorkerStream).toHaveBeenCalledTimes(1);
    expect(registerWorkerStream.mock.calls[0][0]).toBe(WORKER_ID);

    await response.body!.cancel();
  });

  it("unregisters on cancel (the client disconnecting)", async () => {
    const response = await GET(request(), ctx());
    const controller = registerWorkerStream.mock.calls[0][1];

    await response.body!.cancel();

    expect(unregisterWorkerStream).toHaveBeenCalledWith(WORKER_ID, controller);
  });

  it("unregisters when a ping fails to enqueue, without waiting for cancel", async () => {
    const response = await GET(request(), ctx());
    const controller = registerWorkerStream.mock.calls[0][1] as { enqueue: () => void };
    controller.enqueue = () => {
      throw new Error("controller is closed");
    };

    await vi.advanceTimersByTimeAsync(15_000);

    expect(unregisterWorkerStream).toHaveBeenCalledWith(WORKER_ID, controller);

    await response.body!.cancel();
  });

  it("keeps the stream open and pings on the interval instead of failing", async () => {
    const response = await GET(request(), ctx());
    const controller = registerWorkerStream.mock.calls[0][1] as { enqueue: ReturnType<typeof vi.fn> };
    // start() calls registerWorkerStream with the real controller; wrap enqueue to observe pings
    // without breaking it, unlike the failure test above.
    const enqueue = vi.fn(controller.enqueue.bind(controller));
    controller.enqueue = enqueue;

    await vi.advanceTimersByTimeAsync(15_000);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(unregisterWorkerStream).not.toHaveBeenCalled();

    await response.body!.cancel();
  });
});
