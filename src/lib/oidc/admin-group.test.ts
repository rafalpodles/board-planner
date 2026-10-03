import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const updateOne = vi.fn();
const countDocuments = vi.fn();
const logInstanceAudit = vi.fn();
vi.mock("@/models/user", () => ({ User: { updateOne, countDocuments } }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));

const { applyAdminGroup } = await import("./admin-group");

const account = (role: "admin" | "member", extra = {}) =>
  ({ _id: "u1", username: "ada", role, kind: "human", deactivatedAt: null, ...extra }) as never as Parameters<typeof applyAdminGroup>[0];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OIDC_ADMIN_GROUP = "planner-admins";
  updateOne.mockResolvedValue({ modifiedCount: 1 });
  countDocuments.mockResolvedValue(2);
});

afterEach(() => {
  delete process.env.OIDC_ADMIN_GROUP;
});

describe("the admin group", () => {
  it("makes a member in the group an admin, and records it", async () => {
    const user = account("member");

    await applyAdminGroup(user, "oidc", ["staff", "planner-admins"]);

    expect(updateOne).toHaveBeenCalledWith({ _id: "u1", role: "member" }, { $set: { role: "admin" } });
    expect(user.role).toBe("admin");
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_role_changed", target: "ada", detail: expect.stringContaining("member → admin") })
    );
  });

  it("makes an admin outside the group a member, and records it", async () => {
    const user = account("admin");

    await applyAdminGroup(user, "oidc", ["staff"]);

    expect(updateOne).toHaveBeenCalledWith({ _id: "u1", role: "admin" }, { $set: { role: "member" } });
    expect(user.role).toBe("member");
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_role_changed", detail: expect.stringContaining("admin → member") })
    );
  });

  // BP-845. A deactivated admin administers nothing, so is no admin left
  it("counts only active administrators when deciding whether one would be left", async () => {
    await applyAdminGroup(account("admin"), "oidc", []);

    expect(countDocuments).toHaveBeenCalledWith({ role: "admin", deactivatedAt: null });
  });

  it("records nothing and changes nothing when a racing request promoted them first", async () => {
    updateOne.mockResolvedValue({ modifiedCount: 0 });
    const user = account("member");

    await applyAdminGroup(user, "oidc", ["planner-admins"]);

    expect(user.role).toBe("member");
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("changes nothing for a machine account", async () => {
    await applyAdminGroup(account("member", { kind: "machine" }), "oidc", ["planner-admins"]);
    await applyAdminGroup(account("admin", { kind: "machine" }), "oidc", []);

    expect(updateOne).not.toHaveBeenCalled();
  });

  it("never demotes the last active admin", async () => {
    countDocuments.mockResolvedValue(1);
    const user = account("admin");

    await applyAdminGroup(user, "oidc", []);

    expect(updateOne).not.toHaveBeenCalled();
    expect(user.role).toBe("admin");
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("puts the role back when a racing demotion left no admin at all", async () => {
    countDocuments.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const user = account("admin");

    await applyAdminGroup(user, "oidc", []);

    expect(updateOne).toHaveBeenLastCalledWith({ _id: "u1" }, { $set: { role: "admin" } });
    expect(user.role).toBe("admin");
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("leaves alone a role it already agrees with", async () => {
    await applyAdminGroup(account("admin"), "oidc", ["planner-admins"]);
    await applyAdminGroup(account("member"), "oidc", []);

    expect(updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ["no group configured", () => delete process.env.OIDC_ADMIN_GROUP, "oidc"],
    ["a sign-in through Google", () => {}, "google"],
    ["a sign-in through GitHub", () => {}, "github"],
  ])("changes nothing for %s", async (_label, setUp, provider) => {
    setUp();

    await applyAdminGroup(account("member"), provider, ["planner-admins"]);
    await applyAdminGroup(account("admin"), provider, []);

    expect(updateOne).not.toHaveBeenCalled();
  });

  it("changes nothing for a deactivated account", async () => {
    await applyAdminGroup(account("member", { deactivatedAt: new Date() }), "oidc", ["planner-admins"]);

    expect(updateOne).not.toHaveBeenCalled();
  });
});
