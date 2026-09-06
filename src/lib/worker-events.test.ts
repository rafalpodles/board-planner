import { describe, it, expect, vi } from "vitest";
import { registerWorkerStream, unregisterWorkerStream, publishToWorker } from "./worker-events";

function fakeController() {
  return { enqueue: vi.fn() } as unknown as ReadableStreamDefaultController<Uint8Array> & {
    enqueue: ReturnType<typeof vi.fn>;
  };
}

function frameOf(call: unknown[]): string {
  return new TextDecoder().decode(call[0] as Uint8Array);
}

describe("worker-events", () => {
  it("does nothing when publishing to a worker with no open stream", () => {
    expect(() => publishToWorker("w-absent", { command: "pause" })).not.toThrow();
  });

  it("delivers a command frame to the registered controller", () => {
    const controller = fakeController();
    registerWorkerStream("w-deliver", controller);

    publishToWorker("w-deliver", { command: "pause" });

    expect(controller.enqueue).toHaveBeenCalledTimes(1);
    expect(frameOf(controller.enqueue.mock.calls[0])).toBe('event: command\ndata: {"command":"pause"}\n\n');
  });

  it("carries the issuance in the frame, so the worker can dedupe it against its heartbeat", () => {
    const controller = fakeController();
    registerWorkerStream("w-issued", controller);

    publishToWorker("w-issued", { command: "stop", commandIssuedAt: "2026-08-01T12:00:00.000Z" });

    expect(frameOf(controller.enqueue.mock.calls[0])).toBe(
      'event: command\ndata: {"command":"stop","commandIssuedAt":"2026-08-01T12:00:00.000Z"}\n\n'
    );
  });

  it("scopes delivery to the published worker id", () => {
    const a = fakeController();
    const b = fakeController();
    registerWorkerStream("w-scope-a", a);
    registerWorkerStream("w-scope-b", b);

    publishToWorker("w-scope-b", { command: "resume" });

    expect(b.enqueue).toHaveBeenCalledTimes(1);
    expect(a.enqueue).not.toHaveBeenCalled();
  });

  it("stops delivering once unregistered", () => {
    const controller = fakeController();
    registerWorkerStream("w-unregister", controller);
    unregisterWorkerStream("w-unregister", controller);

    publishToWorker("w-unregister", { command: "pause" });

    expect(controller.enqueue).not.toHaveBeenCalled();
  });

  it("does not let a stale unregister from a superseded connection evict the newer one", () => {
    const first = fakeController();
    const second = fakeController();
    registerWorkerStream("w-stale", first);
    registerWorkerStream("w-stale", second); // a reconnect replaces the registration

    unregisterWorkerStream("w-stale", first); // the old connection's cleanup, arriving late

    publishToWorker("w-stale", { command: "stop" });

    expect(second.enqueue).toHaveBeenCalledTimes(1);
    expect(first.enqueue).not.toHaveBeenCalled();
  });

  it("swallows an enqueue failure and drops the controller, so a later publish does not retry it", () => {
    const controller = fakeController();
    controller.enqueue.mockImplementation(() => {
      throw new Error("controller is closed");
    });
    registerWorkerStream("w-broken", controller);

    expect(() => publishToWorker("w-broken", { command: "stop" })).not.toThrow();
    publishToWorker("w-broken", { command: "stop" });

    expect(controller.enqueue).toHaveBeenCalledTimes(1);
  });
});
