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

  it("stores the actor's username beside the reference", async () => {
    await logInstanceAudit({
      action: "user_deleted",
      target: "someone",
      user: "admin-1",
      actorUsername: "rafal",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ user: "admin-1", actorUsername: "rafal" })
    );
  });

  it("swallows a failing write rather than rejecting", async () => {
    create.mockRejectedValue(new Error("mongo is down"));

    await expect(
      logInstanceAudit({ action: "worker_locked", target: "rig-laptop" })
    ).resolves.toBeUndefined();
  });
});
