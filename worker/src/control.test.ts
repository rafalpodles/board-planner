import { afterEach, describe, it, expect, vi } from "vitest";
import { connectControl, ControlDeps, WorkerCommand } from "./control.js";

// Delivers the given chunks, then hangs — like a live connection that has said everything it has
// so far but stays open. Frame-parsing tests use this so no reconnect is ever scheduled, which
// would otherwise race the assertions below.
function openStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

// Delivers the given chunks, then ends — like a dropped connection.
function closingStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function handlerStub() {
  return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() } satisfies Record<WorkerCommand, ReturnType<typeof vi.fn>>;
}

function depsWith(overrides: Partial<ControlDeps> = {}): ControlDeps {
  return {
    apiBaseUrl: "https://app.example.com",
    identitySource: { read: () => JSON.stringify({ workerId: "w1", credential: "cpw_x" }) },
    handlers: handlerStub(),
    log: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("connectControl — frame parsing", () => {
  it.each(["pause", "resume", "stop"] as const)(
    "calls the %s handler for a matching command frame",
    async (command) => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: openStream([`event: command\ndata: {"command":"${command}"}\n\n`]),
      }));
      const handlers = handlerStub();

      const control = connectControl(depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, handlers }));

      await vi.waitFor(() => expect(handlers[command]).toHaveBeenCalledTimes(1));
      for (const other of (["pause", "resume", "stop"] as const).filter((c) => c !== command)) {
        expect(handlers[other]).not.toHaveBeenCalled();
      }
      control.close();
    }
  );

  it("extracts multiple frames delivered in a single chunk", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: openStream([
        ': ping\n\nevent: command\ndata: {"command":"pause"}\n\nevent: command\ndata: {"command":"resume"}\n\n',
      ]),
    }));
    const handlers = handlerStub();

    const control = connectControl(depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, handlers }));

    await vi.waitFor(() => expect(handlers.resume).toHaveBeenCalledTimes(1));
    expect(handlers.pause).toHaveBeenCalledTimes(1);
    control.close();
  });

  it("reassembles a frame split across separate reads", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: openStream(["event: com", 'mand\ndata: {"command":"pause"}\n\n']),
    }));
    const handlers = handlerStub();

    const control = connectControl(depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, handlers }));

    await vi.waitFor(() => expect(handlers.pause).toHaveBeenCalledTimes(1));
    control.close();
  });

  it("skips a malformed frame instead of throwing, and keeps reading the ones after it", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: openStream([
        "event: command\ndata: not-json\n\n",
        'event: command\ndata: {"command":"pause"}\n\n',
      ]),
    }));
    const handlers = handlerStub();

    const control = connectControl(depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, handlers }));

    await vi.waitFor(() => expect(handlers.pause).toHaveBeenCalledTimes(1));
    control.close();
  });

  it("ignores a command name outside pause/resume/stop", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: openStream([
        'event: command\ndata: {"command":"reboot"}\n\n',
        'event: command\ndata: {"command":"resume"}\n\n',
      ]),
    }));
    const handlers = handlerStub();

    const control = connectControl(depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, handlers }));

    await vi.waitFor(() => expect(handlers.resume).toHaveBeenCalledTimes(1));
    expect(handlers.pause).not.toHaveBeenCalled();
    expect(handlers.stop).not.toHaveBeenCalled();
    control.close();
  });

  it("ignores : ping comment frames", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: openStream([": ping\n\n", 'event: command\ndata: {"command":"stop"}\n\n']),
    }));
    const handlers = handlerStub();

    const control = connectControl(depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, handlers }));

    await vi.waitFor(() => expect(handlers.stop).toHaveBeenCalledTimes(1));
    expect(handlers.pause).not.toHaveBeenCalled();
    expect(handlers.resume).not.toHaveBeenCalled();
    control.close();
  });

  it("sends the worker credential, X-Worker-Id and X-CP-Protocol headers", async () => {
    // Declared with the arguments it is called with, not none: this is the one test that reads
    // mock.calls, and a zero-argument stub gives an empty tuple to destructure
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string> }) => ({
        ok: true,
        status: 200,
        body: openStream([]),
      })
    );

    const control = connectControl(depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/workers/w1/stream");
    expect(init.headers.Authorization).toBe("Bearer cpw_x");
    expect(init.headers["X-Worker-Id"]).toBe("w1");
    expect(init.headers["X-CP-Protocol"]).toBe("1");
    control.close();
  });
});

// Driven with fake timers and manual advances, never vi.waitFor's real-time polling: the backoff
// delays are exact numbers here, and polling against them would race a live clock.
describe("connectControl — reconnect scheduling", () => {
  it("schedules a reconnect with backoff after the stream ends, growing on repeated immediate EOF, without throwing", async () => {
    vi.useFakeTimers();
    // Every connect gets a fresh, already-closing stream: an HTTP 200 whose body ends without
    // ever delivering a byte, on every attempt. This is the case the backoff-reset bug hid in —
    // resetting on response.ok alone (rather than on data actually being read) made every retry
    // look "successful" and collapsed the backoff back to the base delay each time.
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: closingStream([]) }));
    const control = connectControl(
      depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, reconnectDelayMs: 1000 })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Second cycle: the delay must double, not collapse back to the base — this is the part a
    // single-cycle assertion cannot tell apart from the bug, since the first delay is 1000ms
    // either way.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    control.close();
  });

  it("reconnects after a network error without throwing", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200, body: openStream([]) };
    });
    const control = connectControl(
      depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, reconnectDelayMs: 1000 })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    control.close();
  });

  it("reconnects after a non-ok response without throwing", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 403, body: null }
        : { ok: true, status: 200, body: openStream([]) };
    });
    const control = connectControl(
      depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, reconnectDelayMs: 1000 })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    control.close();
  });

  it("does not connect before an identity exists, and connects once one appears", async () => {
    vi.useFakeTimers();
    let text = "";
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: openStream([]) }));
    const control = connectControl(
      depsWith({
        identitySource: { read: () => text },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        reconnectDelayMs: 1000,
      })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    text = JSON.stringify({ workerId: "w1", credential: "cpw_x" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    control.close();
  });

  it("stops reconnecting once closed", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: closingStream([]) }));
    const control = connectControl(
      depsWith({ fetchImpl: fetchImpl as unknown as typeof fetch, reconnectDelayMs: 1000 })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    control.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
