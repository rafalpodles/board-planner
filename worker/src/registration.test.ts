import { describe, it, expect, vi } from "vitest";
import { CommandHandlers } from "./commands.js";
import { HeartbeatDeps, Store, loadIdentity, startHeartbeat } from "./registration.js";

type Stored = { workerId: string; credential: string; heartbeatMs: number };

function handlerStub(): CommandHandlers {
  return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
}

function depsWith(
  opts: {
    status?: number;
    throws?: Error;
    stored?: Stored | null;
    registerResponse?: Partial<Stored>;
    body?: Record<string, unknown>;
    handlers?: CommandHandlers;
    enrolmentToken?: string;
    registerStatus?: number;
    forgetEnrolmentToken?: () => void;
  } = {}
): HeartbeatDeps {
  const initialStored = opts.stored === undefined ? { workerId: "6a7c686f70ed274cf658b1b3", credential: "cpw_existing", heartbeatMs: 60_000 } : opts.stored;

  let text = initialStored ? JSON.stringify(initialStored) : "";
  const write = vi.fn((value: string) => {
    text = value;
  });
  const store: Store = { read: () => text, write };

  const fetchImpl = vi.fn(async (url: string) => {
    if (opts.throws) throw opts.throws;
    if (String(url).endsWith("/api/workers/register")) {
      if (opts.registerStatus && opts.registerStatus >= 400) {
        return { ok: false, status: opts.registerStatus, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ workerId: "6a7c686f70ed274cf658b1b3", credential: "cpw_new", heartbeatMs: 60_000, ...opts.registerResponse }),
      };
    }
    const status = opts.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => opts.body ?? {} };
  });

  return {
    apiBaseUrl: "https://app.example.com",
    enrolmentToken: opts.enrolmentToken === undefined ? "cpe_one_time" : opts.enrolmentToken,
    forgetEnrolmentToken: opts.forgetEnrolmentToken,
    registration: { name: "worker-1", host: "host-1", platform: "darwin", version: "1.0.0" },
    store,
    handlers: opts.handlers ?? handlerStub(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    log: vi.fn(),
  };
}

function calls(deps: HeartbeatDeps) {
  return (deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

describe("loadIdentity", () => {
  it("returns null when the store is empty", () => {
    expect(loadIdentity({ read: () => "" })).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(loadIdentity({ read: () => "{not json" })).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(loadIdentity({ read: () => JSON.stringify({ workerId: "6a7c686f70ed274cf658b1b3" }) })).toBeNull();
  });

  it("returns the identity when both fields are present, ignoring extra fields", () => {
    const text = JSON.stringify({ workerId: "6a7c686f70ed274cf658b1b3", credential: "cpw_x", heartbeatMs: 60_000 });
    expect(loadIdentity({ read: () => text })).toEqual({ workerId: "6a7c686f70ed274cf658b1b3", credential: "cpw_x" });
  });

  // The identity file lives under the state directory, which the agent reaches through its own
  // HOME. A still-valid credential paired with a rewritten workerId is the reachable half of it.
  it("returns null when the stored workerId is not the ObjectId the server mints", () => {
    const text = JSON.stringify({ workerId: "../../evil", credential: "cpw_x", heartbeatMs: 60_000 });
    expect(loadIdentity({ read: () => text })).toBeNull();
  });
});

// BP-327: the register response's workerId becomes a filesystem path — repos.ts derives the
// worktree root from it — so "a non-empty string" was never a strong enough shape for it.
describe("the workerId a registration hands back", () => {
  it("is refused when it would traverse out of the worktree root", async () => {
    const deps = depsWith({
      stored: null,
      registerResponse: { workerId: "../../../../Users/rpo/Library/LaunchAgents" },
    });

    await startHeartbeat(deps).tick();

    expect(loadIdentity(deps.store)).toBeNull();
    expect(calls(deps).some(([url]) => String(url).includes("/heartbeat"))).toBe(false);
  });

  it("is refused when it is an ObjectId of the wrong length", async () => {
    const deps = depsWith({ stored: null, registerResponse: { workerId: "6a7c686f70ed274cf658b1" } });

    await startHeartbeat(deps).tick();

    expect(loadIdentity(deps.store)).toBeNull();
  });

  // The enrolment token is spent by the registration that returned the bad id, so forgetting it
  // here would strand the worker with no way to try again
  it("leaves the enrolment token in place when it refuses", async () => {
    const forgetEnrolmentToken = vi.fn();
    const deps = depsWith({
      stored: null,
      forgetEnrolmentToken,
      registerResponse: { workerId: "../evil" },
    });

    await startHeartbeat(deps).tick();

    expect(forgetEnrolmentToken).not.toHaveBeenCalled();
  });

  it("is accepted when it is one", async () => {
    const deps = depsWith({ stored: null, registerResponse: { workerId: "6a7c686f70ed274cf658b1b3" } });

    await startHeartbeat(deps).tick();

    expect(loadIdentity(deps.store)?.workerId).toBe("6a7c686f70ed274cf658b1b3");
  });
});

describe("startHeartbeat", () => {
  it("reuses a stored identity instead of registering again", async () => {
    const deps = depsWith();

    await startHeartbeat(deps).tick();

    expect(calls(deps).some(([url]) => String(url).endsWith("/api/workers/register"))).toBe(false);
  });

  it("persists the credential at mode 0600 when registering for the first time", async () => {
    const deps = depsWith({ stored: null });

    await startHeartbeat(deps).tick();

    expect(deps.store.write).toHaveBeenCalledWith(expect.any(String), { mode: 0o600 });
  });

  // Registration authenticates with a single-use enrolment token, never the operational token. The
  // agent runs at this uid with Read, so whatever sits on this disk must not be able to lift the
  // worker's own kill switch — and an unscoped admin token could.
  it("registers with the enrolment token, not the operational one", async () => {
    const deps = depsWith({ stored: null });

    await startHeartbeat(deps).tick();

    const [, init] = calls(deps).find(([url]) => String(url).endsWith("/api/workers/register"))!;
    expect(init.headers.Authorization).toBe("Bearer cpe_one_time");
    expect(init.headers["X-CP-Protocol"]).toBe("1");
  });

  it("removes the spent enrolment token once the credential is safely on disk", async () => {
    const forget = vi.fn();
    const deps = depsWith({ stored: null, forgetEnrolmentToken: forget });

    await startHeartbeat(deps).tick();

    expect(deps.store.write).toHaveBeenCalled();
    expect(forget).toHaveBeenCalledTimes(1);
  });

  // Order matters: forgetting first would strand the worker with a spent token and no credential
  it("keeps the token when registration fails", async () => {
    const forget = vi.fn();
    const deps = depsWith({ stored: null, registerStatus: 401, forgetEnrolmentToken: forget });

    await startHeartbeat(deps).tick();

    expect(forget).not.toHaveBeenCalled();
  });

  // The failure the ordering exists for: if the credential cannot be persisted and the token has
  // already been spent server-side, deleting it too leaves this worker unable to ever register.
  it("keeps the token when the credential cannot be written to disk", async () => {
    const forget = vi.fn();
    const deps = depsWith({ stored: null, forgetEnrolmentToken: forget });
    (deps.store.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("disk full");
    });

    await startHeartbeat(deps).tick();

    expect(forget).not.toHaveBeenCalled();
  });

  it("does not attempt to register at all with no enrolment token", async () => {
    const deps = depsWith({ stored: null, enrolmentToken: "" });

    await startHeartbeat(deps).tick();

    expect(calls(deps).some(([url]) => String(url).endsWith("/api/workers/register"))).toBe(false);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("CP_ENROLMENT_TOKEN"));
  });

  // An enrolled worker must keep booting after the operator deletes the token, which is the whole
  // point of removing it
  it("still heartbeats on a stored identity with no enrolment token present", async () => {
    const deps = depsWith({ enrolmentToken: "" });

    await startHeartbeat(deps).tick();

    const [, init] = calls(deps)[0];
    expect(init.headers.Authorization).toBe("Bearer cpw_existing");
  });

  it("sends the worker credential, X-Worker-Id and X-CP-Protocol on the heartbeat", async () => {
    const deps = depsWith();

    await startHeartbeat(deps).tick();

    const [, init] = calls(deps)[0];
    expect(init.headers.Authorization).toBe("Bearer cpw_existing");
    expect(init.headers["X-Worker-Id"]).toBe("6a7c686f70ed274cf658b1b3");
    expect(init.headers["X-CP-Protocol"]).toBe("1");
  });

  it("aborts the run in flight when the heartbeat is refused", async () => {
    const onAbort = vi.fn();
    const heartbeat = startHeartbeat(depsWith({ status: 403 }));
    heartbeat.onAbort(onAbort);

    await heartbeat.tick();

    expect(onAbort).toHaveBeenCalled();
  });

  // A network blip is not a kill switch
  it("does not abort when the heartbeat merely fails to reach the server", async () => {
    const onAbort = vi.fn();
    const heartbeat = startHeartbeat(depsWith({ throws: new Error("ECONNREFUSED") }));
    heartbeat.onAbort(onAbort);

    await heartbeat.tick();

    expect(onAbort).not.toHaveBeenCalled();
  });

  // The other half of the 401-vs-network distinction: a blip must not make the worker treat its
  // own credential as invalid, or it would re-register and mint a duplicate identity
  it("does not clear the stored identity when the heartbeat merely fails to reach the server", async () => {
    const deps = depsWith({ throws: new Error("ECONNREFUSED") });

    await startHeartbeat(deps).tick();

    expect(deps.store.write).not.toHaveBeenCalled();
  });

  it("echoes the command it applied, so the console can stop saying Pausing", async () => {
    const deps = depsWith();
    const heartbeat = startHeartbeat(deps);

    heartbeat.ack("pause");
    await heartbeat.tick();

    const [, init] = calls(deps)[0];
    expect(JSON.parse(init.body).acked).toBe("pause");
  });

  it("sends no acked field before ack() has ever been called", async () => {
    const deps = depsWith();

    await startHeartbeat(deps).tick();

    const [, init] = calls(deps)[0];
    expect(JSON.parse(init.body).acked).toBeUndefined();
  });

  it("dispatches the standing command carried by the heartbeat body", async () => {
    const handlers = handlerStub();
    const deps = depsWith({
      handlers,
      body: { command: "pause", commandIssuedAt: "2026-08-01T12:00:00.000Z" },
    });

    await startHeartbeat(deps).tick();

    expect(handlers.pause).toHaveBeenCalledWith("2026-08-01T12:00:00.000Z");
    expect(handlers.resume).not.toHaveBeenCalled();
    expect(handlers.stop).not.toHaveBeenCalled();
  });

  it("dispatches a command whose issuance the server left out, rather than dropping it", async () => {
    const handlers = handlerStub();

    await startHeartbeat(depsWith({ handlers, body: { command: "stop" } })).tick();

    expect(handlers.stop).toHaveBeenCalledWith(undefined);
  });

  it("dispatches nothing for a command name outside pause/resume/stop", async () => {
    const handlers = handlerStub();

    await startHeartbeat(depsWith({ handlers, body: { command: "reboot" } })).tick();

    expect(handlers.pause).not.toHaveBeenCalled();
    expect(handlers.resume).not.toHaveBeenCalled();
    expect(handlers.stop).not.toHaveBeenCalled();
  });

  // A refusal is already an abort; obeying a stale command from the same response would be a
  // second, unrelated state change on a worker the server has just cut off
  it("dispatches no command on a refused heartbeat", async () => {
    const handlers = handlerStub();
    const heartbeat = startHeartbeat(
      depsWith({ handlers, status: 403, body: { command: "pause" } })
    );

    await heartbeat.tick();

    expect(handlers.pause).not.toHaveBeenCalled();
  });

  it("clears the stored identity on a 401, so the next tick registers again", async () => {
    const deps = depsWith({ status: 401 });

    await startHeartbeat(deps).tick();

    expect(deps.store.write).toHaveBeenCalledWith("", { mode: 0o600 });
  });

  it("does not call the server once stopped", async () => {
    const deps = depsWith();
    const heartbeat = startHeartbeat(deps);
    heartbeat.stop();

    await heartbeat.tick();

    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not throw when registration itself fails over the network", async () => {
    const deps = depsWith({ stored: null, throws: new Error("ECONNREFUSED") });

    await expect(startHeartbeat(deps).tick()).resolves.toBeUndefined();
    expect(deps.store.write).not.toHaveBeenCalled();
  });

  it("sends an empty binding error when nothing has ever been reported", async () => {
    const deps = depsWith();

    await startHeartbeat(deps).tick();

    const [, init] = calls(deps)[0];
    expect(JSON.parse(init.body).bindingError).toBe("");
  });

  it("sends the reported binding error on the next heartbeat", async () => {
    const deps = depsWith();
    const heartbeat = startHeartbeat(deps);

    heartbeat.reportBindingError("p1: not approved on this machine — add it to repos.json");
    await heartbeat.tick();

    const [, init] = calls(deps)[0];
    expect(JSON.parse(init.body).bindingError).toBe(
      "p1: not approved on this machine — add it to repos.json"
    );
  });

  // The operator fixes repos.json; the server-side field must clear, not stay stuck forever
  it("clears a previously reported binding error once told there is none", async () => {
    const deps = depsWith();
    const heartbeat = startHeartbeat(deps);

    heartbeat.reportBindingError("p1: not approved on this machine");
    heartbeat.reportBindingError("");
    await heartbeat.tick();

    const [, init] = calls(deps)[0];
    expect(JSON.parse(init.body).bindingError).toBe("");
  });
});
