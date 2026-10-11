import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { eraseAccountTraces, erasedLabel, scrubNames } = await import("./account-erasure");

const USER = { _id: "6a9d0f0b5d781bded2cb975a", username: "jan", email: "jan@example.com", fullName: "Jan Kowalski" };
const LABEL = erasedLabel(USER._id);

type Rows = Record<string, unknown>[];

function fakeDb(seed: Partial<Record<"InstanceAuditLog" | "ProjectAuditLog" | "Worker" | "User", Rows>> = {}) {
  const calls: { model: string; op: string; args: unknown[] }[] = [];
  const record = (model: string, op: string) => async (...args: unknown[]) => {
    calls.push({ model, op, args });
    return { deletedCount: 0, modifiedCount: 0 };
  };
  const reader = (model: string) => (...args: unknown[]) => {
    calls.push({ model, op: "find", args });
    const chain = { select: () => chain, sort: () => chain, lean: async () => seed[model as keyof typeof seed] ?? [] };
    return chain;
  };
  const model = (name: string) => ({
    find: reader(name),
    findById: (...args: unknown[]) => {
      calls.push({ model: name, op: "findById", args });
      const found = (seed[name as keyof typeof seed] ?? [])[0];
      return { select: async () => found };
    },
    deleteMany: record(name, "deleteMany"),
    updateMany: record(name, "updateMany"),
    updateOne: record(name, "updateOne"),
  });
  const models = new Map<string, ReturnType<typeof model>>();
  const db = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => {
      if (!models.has(name)) models.set(name, model(name));
      return models.get(name);
    },
  });
  const of = (modelName: string, op: string) => calls.filter((c) => c.model === modelName && c.op === op);
  return { db: db as never, calls, of };
}

describe("scrubNames", () => {
  it("replaces a username wherever it stands as a word, in any case, mentions included", () => {
    expect(scrubNames("Jan changed it; @jan said so, and JAN.", ["jan"], LABEL)).toBe(
      `${LABEL} changed it; @${LABEL} said so, and ${LABEL}.`
    );
  });

  it("leaves a longer name that merely contains it alone", () => {
    expect(scrubNames("janusz, jan-pawel and ex_jan and jan2", ["jan"], LABEL)).toBe("janusz, jan-pawel and ex_jan and jan2");
  });

  it("replaces an e-mail address whole, dots and plus signs included", () => {
    expect(scrubNames("jan+x@example.com → b@example.com", ["jan+x@example.com"], LABEL)).toBe(`${LABEL} → b@example.com`);
  });
});

describe("erasing the traces of a deleted account", () => {
  it("returns a label that is opaque yet stable for the same account", async () => {
    const { db } = fakeDb();
    expect(await eraseAccountTraces(db, USER)).toBe(LABEL);
    expect(LABEL).toMatch(/^deleted-[0-9a-f]{8}$/);
    expect(LABEL).not.toContain(USER.username);
  });

  it("deletes the notifications the person received or caused, their PM conversations and consents", async () => {
    const { db, of } = fakeDb();
    await eraseAccountTraces(db, USER);

    expect(of("Notification", "deleteMany")[0].args[0]).toEqual({ $or: [{ recipient: USER._id }, { actor: USER._id }] });
    expect(of("PmMessage", "deleteMany")[0].args[0]).toEqual({ triggeredBy: USER._id });
    expect(of("OAuthConsent", "deleteMany")[0].args[0]).toEqual({ user: USER._id });
  });

  it("deletes invitations the person accepted or that were sent to their address", async () => {
    const { db, of } = fakeDb();
    await eraseAccountTraces(db, USER);
    expect(of("Invitation", "deleteMany")[0].args[0]).toEqual({ $or: [{ acceptedBy: USER._id }, { email: USER.email }] });
  });

  it("rewrites the username the history keeps as the assignee, on both sides of a change", async () => {
    const { db, of } = fakeDb();
    await eraseAccountTraces(db, USER);

    const writes = of("ActivityLog", "updateMany").map((c) => c.args);
    expect(writes).toContainEqual([{ field: "assignee", oldValue: "jan" }, { $set: { oldValue: LABEL } }]);
    expect(writes).toContainEqual([{ field: "assignee", newValue: "jan" }, { $set: { newValue: LABEL } }]);
  });

  it("rewrites audit rows that name the person, in the actor, the target and the detail, and nothing else", async () => {
    const { db, of } = fakeDb({
      InstanceAuditLog: [
        { _id: "a1", actorUsername: "jan", target: "jan", detail: "jan@example.com → jan.k@example.com" },
        { _id: "a2", actorUsername: "ola", target: "jan", detail: "a member" },
        { _id: "a3", actorUsername: "ola", target: "ola", detail: "nothing here" },
      ],
    });
    await eraseAccountTraces(db, USER);

    const updates = of("InstanceAuditLog", "updateOne").map((c) => c.args);
    expect(updates).toContainEqual([
      { _id: "a1" },
      { $set: { actorUsername: LABEL, target: LABEL, detail: `${LABEL} → jan.k@example.com` } },
    ]);
    expect(updates).toContainEqual([{ _id: "a2" }, { $set: { target: LABEL } }]);
    expect(updates.find(([filter]) => (filter as { _id: string })._id === "a3")).toBeUndefined();
  });

  it("rewrites a board's log where the detail or a line names the person", async () => {
    const { db, of } = fakeDb({
      ProjectAuditLog: [{ _id: "p1", detail: "jan was made owner", lines: ["role: member → owner (jan)", "unrelated"] }],
    });
    await eraseAccountTraces(db, USER);

    expect(of("ProjectAuditLog", "updateOne")[0].args).toEqual([
      { _id: "p1" },
      { $set: { detail: `${LABEL} was made owner`, lines: [`role: member → owner (${LABEL})`, "unrelated"] } },
    ]);
  });

  it("releases the person's machines and takes their name off the machine's own", async () => {
    const { db, of } = fakeDb({
      Worker: [{ _id: "w1", name: "MacBook", identity: "m1" }],
      User: [{ _id: "m1", fullName: "Jan Kowalski · MacBook" }],
    });
    await eraseAccountTraces(db, USER);

    expect(of("Worker", "updateOne")[0].args).toEqual([{ _id: "w1" }, { $set: { owner: null, enabled: false } }]);
    expect(of("User", "updateOne")[0].args).toEqual([{ _id: "m1" }, { $set: { fullName: "MacBook" } }]);
  });
});
