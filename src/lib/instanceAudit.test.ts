import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@/models/instanceAuditLog", () => ({ InstanceAuditLog: { create } }));

const { logInstanceAudit } = await import("./instanceAudit");

describe("logInstanceAudit", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("records the actor, the action and what was acted on", async () => {
    await logInstanceAudit({
      action: "worker_locked",
      target: "rig-laptop",
      user: "admin-1",
      detail: "Kill switch on",
    });

    expect(create).toHaveBeenCalledWith({
      user: "admin-1",
      actorUsername: "",
      action: "worker_locked",
      target: "rig-laptop",
      detail: "Kill switch on",
    });
  });

  // A worker spends its enrolment token during registration, where the caller is a machine with no
  // session. An entry nobody can attribute is still worth more than no entry.
  it("stores a null actor rather than refusing an entry no user made", async () => {
    await logInstanceAudit({ action: "enrolment_token_spent", target: "rig-laptop" });

    expect(create).toHaveBeenCalledWith({
      user: null,
      actorUsername: "",
      action: "enrolment_token_spent",
      target: "rig-laptop",
      detail: "",
    });
  });

  // BP-539. The reference stops naming anybody the moment that account is deleted, which used to
  // rewrite every row they wrote as "system" — the word this log reserves for a machine. Stored
  // beside it, so the row outlives its actor the way it already outlives its subject.
  it("stores the actor's username beside the reference", async () => {
    await logInstanceAudit({
      action: "user_deleted",
      target: "someone",
      user: "admin-1",
      actorUsername: "owner",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ user: "admin-1", actorUsername: "owner" })
    );
  });

  // The property the callers depend on to write `void logInstanceAudit(...)` without a catch of
  // their own: an audit row that could fail the action it records would be worse than the gap it
  // closes, and an unhandled rejection would take the process down instead.
  it("swallows a failing write rather than rejecting", async () => {
    create.mockRejectedValue(new Error("mongo is down"));

    await expect(
      logInstanceAudit({ action: "worker_locked", target: "rig-laptop" })
    ).resolves.toBeUndefined();
  });
});
