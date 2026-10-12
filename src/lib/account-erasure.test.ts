import { describe, it, expect, vi } from "vitest";
import { memoryDb } from "./memory-db-test-store";

const removeUploads = vi.fn(async (_ids: string[]) => {});
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/upload-ownership", () => ({ organisationUploads: () => ({ remove: removeUploads }) }));

const { eraseAccountTraces, erasedLabel, findOrphanReferences, eraseOrphanReferences, ORPHAN_SOURCES } = await import("./account-erasure");
const { DELETED_AGENT } = await import("@/types");
const { Types } = await import("mongoose");
const { isErasedLabel } = await import("./erased-label");

const JAN = "6a9d0f0b5d781bded2cb975a";
const OLA = "6a9d0f0b5d781bded2cb975b";
const USER = { _id: JAN, username: "jan", email: "jan@example.com" };
const LABEL = erasedLabel(JAN);

describe("the label a deleted account is left under", () => {
  it("is opaque, stable for the same account and different for another", () => {
    expect(LABEL).toMatch(/^deleted-[0-9a-f]{8}$/);
    expect(LABEL).not.toContain("jan");
    expect(erasedLabel(JAN)).toBe(LABEL);
    expect(erasedLabel(OLA)).not.toBe(LABEL);
    // The server mints it and the client and the username rules recognise it: one shape, two files
    expect(isErasedLabel(LABEL)).toBe(true);
    expect(isErasedLabel("deleted-user")).toBe(false);
  });
});

describe("erasing the traces of a deleted account", () => {
  it("returns the label", async () => {
    expect(await eraseAccountTraces(memoryDb().db, USER)).toBe(LABEL);
  });

  it("deletes the notifications the person received or caused, and only those", async () => {
    const { db, rows } = memoryDb({
      Notification: [
        { _id: "n1", recipient: JAN, actor: OLA },
        { _id: "n2", recipient: OLA, actor: JAN },
        { _id: "n3", recipient: OLA, actor: OLA },
      ],
    });
    await eraseAccountTraces(db, USER);
    expect(rows("Notification").map((n) => n._id)).toEqual(["n3"]);
  });

  it("deletes the person's PM conversations and the files attached to them, nobody else's", async () => {
    removeUploads.mockClear();
    const { db, rows } = memoryDb({
      PmMessage: [
        { _id: "m1", triggeredBy: JAN, attachments: [{ fileId: "f1" }, { fileId: "f2" }] },
        { _id: "m2", triggeredBy: JAN, attachments: [] },
        { _id: "m3", triggeredBy: OLA, attachments: [{ fileId: "f3" }] },
      ],
    });
    await eraseAccountTraces(db, USER);
    expect(rows("PmMessage").map((m) => m._id)).toEqual(["m3"]);
    // Scoped to the uploader: a message may name any file of its board, and those are not this person's
    expect(removeUploads).toHaveBeenCalledWith(["f1", "f2"], JAN);
  });

  it("deletes consents and the invitations the person accepted or that were sent to their address", async () => {
    const { db, rows } = memoryDb({
      OAuthConsent: [{ _id: "c1", user: JAN }, { _id: "c2", user: OLA }],
      Invitation: [
        { _id: "i1", acceptedBy: JAN, email: "x@example.com" },
        { _id: "i2", acceptedBy: null, email: "jan@example.com" },
        { _id: "i3", acceptedBy: OLA, email: "ola@example.com" },
      ],
    });
    await eraseAccountTraces(db, USER);
    expect(rows("OAuthConsent").map((c) => c._id)).toEqual(["c2"]);
    expect(rows("Invitation").map((i) => i._id)).toEqual(["i3"]);
  });

  it("leaves no task pointing at the person, quietly, and keeps everybody else's", async () => {
    const { db, rows, calls } = memoryDb({
      Task: [
        { _id: "t1", assignee: JAN, assignedBy: OLA, pmAssignedFor: null, watchers: [JAN, OLA] },
        { _id: "t2", assignee: OLA, assignedBy: JAN, pmAssignedFor: JAN, watchers: [OLA] },
      ],
    });
    await eraseAccountTraces(db, USER);
    expect(rows("Task")).toEqual([
      { _id: "t1", assignee: null, assignedBy: OLA, pmAssignedFor: null, watchers: [OLA] },
      { _id: "t2", assignee: OLA, assignedBy: null, pmAssignedFor: null, watchers: [OLA] },
    ]);
    // An edit time that moved would show a task as changed by a person who left
    expect(calls.filter((c) => c.model === "Task" && c.op === "updateMany").every((c) => (c.options as { timestamps: boolean }).timestamps === false)).toBe(true);
  });

  it("rewrites the username history keeps as the assignee, on both sides of a change", async () => {
    const { db, rows } = memoryDb({
      ActivityLog: [
        { _id: "a1", field: "assignee", oldValue: "", newValue: "jan" },
        { _id: "a2", field: "assignee", oldValue: "jan", newValue: "ola" },
        { _id: "a3", field: "assignee", oldValue: "ola", newValue: "" },
        { _id: "a4", field: "title", oldValue: "jan", newValue: "Jan's task" },
      ],
    });
    await eraseAccountTraces(db, USER);
    expect(rows("ActivityLog").map((r) => [r.oldValue, r.newValue])).toEqual([
      ["", LABEL],
      [LABEL, "ola"],
      ["ola", ""],
      ["jan", "Jan's task"],
    ]);
  });

  describe("the instance log", () => {
    const seed = () =>
      memoryDb({
        InstanceAuditLog: [
          { _id: "a1", user: JAN, action: "user_email_changed_self", actorUsername: "jan", target: "jan", detail: "old@example.com → jan@example.com" },
          { _id: "a2", user: JAN, action: "user_full_name_changed_self", actorUsername: "jan", target: "jan", detail: "Jan K → Jan Kowalski" },
          { _id: "a3", user: OLA, action: "user_role_changed", actorUsername: "ola", target: "jan", detail: "member → admin" },
          { _id: "a4", user: JAN, action: "invitation_sent", actorUsername: "jan", target: "bob@example.com", detail: "as a member, TP (owner), as a link" },
          { _id: "a5", user: OLA, action: "user_role_changed", actorUsername: "ola", target: "bob", detail: "member → admin" },
          { _id: "a6", user: OLA, action: "user_email_confirmed", actorUsername: "ola", target: "jan", detail: "jan@example.com" },
          { _id: "a7", user: OLA, action: "organisation_exported", actorUsername: "ola", target: "jan", detail: "" },
          { _id: "a8", user: OLA, action: "worker_registered", actorUsername: "ola", target: "jan", detail: "" },
          { _id: "a9", user: JAN, action: "worker_enabled", actorUsername: "jan.old", target: "", detail: "" },
          { _id: "a10", user: OLA, action: "user_email_confirmed", actorUsername: "ola", target: "jan@example.com", detail: "jan@example.com" },
          { _id: "a11", user: JAN, action: "user_email_confirmed_self", actorUsername: "jan", target: "jan", detail: "old@example.com" },
          { _id: "a12", user: JAN, action: "user_created", actorUsername: "", target: "jan", detail: "signed up with Google, jan@example.com being in an allowed domain" },
          { _id: "a13", user: JAN, action: "invitation_accepted", actorUsername: "", target: "jan@example.com", detail: "as a member, account jan, signing in with google" },
          { _id: "a14", user: JAN, action: "user_password_reset_by_email", actorUsername: "", target: "jan", detail: "from 203.0.113.7" },
        ],
      });
    const byId = (rows: Record<string, unknown>[]) => Object.fromEntries(rows.map((r) => [String(r._id), r]));

    it("names the person by the label wherever they are the actor or the target", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, USER);
      const got = byId(rows("InstanceAuditLog"));
      expect(got.a3).toMatchObject({ actorUsername: "ola", target: LABEL, detail: "member → admin" });
      expect(got.a4).toMatchObject({ actorUsername: LABEL, target: "bob@example.com", detail: "as a member, TP (owner), as a link" });
      expect(got.a6).toMatchObject({ target: LABEL, detail: LABEL });
    });

    it("drops the old address and name an account's own change rows carry, not only the current one", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, USER);
      const got = byId(rows("InstanceAuditLog"));
      expect(got.a1).toMatchObject({ actorUsername: LABEL, target: LABEL, detail: LABEL });
      expect(got.a2).toMatchObject({ actorUsername: LABEL, target: LABEL, detail: LABEL });
      expect(JSON.stringify(rows("InstanceAuditLog"))).not.toMatch(/old@example\.com|Jan K/);
    });

    it("finds a row by the account that did it even when the name it was written under has changed since", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, USER);
      expect(byId(rows("InstanceAuditLog")).a9).toMatchObject({ user: JAN, actorUsername: "jan.old" });
      const { db: other, rows: otherRows } = memoryDb({
        InstanceAuditLog: [{ _id: "x", user: JAN, action: "worker_enabled", actorUsername: "jan", target: "", detail: "" }],
      });
      await eraseAccountTraces(other, USER);
      expect(otherRows("InstanceAuditLog")[0].actorUsername).toBe(LABEL);
    });

    it("finds a row about the person's address when it names them by it", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, USER);
      expect(byId(rows("InstanceAuditLog")).a10).toMatchObject({ target: LABEL, detail: LABEL });
    });

    it("drops what the person's own sign-up, confirmation, invitation and reset rows say about them", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, USER);
      const got = byId(rows("InstanceAuditLog"));
      for (const id of ["a11", "a12", "a13", "a14"]) expect(got[id].detail).toBe(LABEL);
      expect(JSON.stringify(rows("InstanceAuditLog"))).not.toMatch(/203\.113|old@example\.com|account jan/);
    });

    it("leaves a target that is not a person alone, even when it spells the username", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, USER);
      const got = byId(rows("InstanceAuditLog"));
      expect(got.a7.target).toBe("jan");
      expect(got.a8.target).toBe("jan");
    });

    it("leaves other people's rows alone, whatever words they share with the person's name", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, { _id: JAN, username: "admin", email: "jan@example.com" });
      const got = byId(rows("InstanceAuditLog"));
      expect(got.a5).toMatchObject({ target: "bob", detail: "member → admin" });
      expect(got.a3).toMatchObject({ target: "jan", detail: "member → admin" });
    });

    it("does not rewrite a role that shares the person's name, in a row about that person", async () => {
      const { db, rows } = memoryDb({
        InstanceAuditLog: [{ _id: "r1", user: OLA, action: "user_role_changed", actorUsername: "ola", target: "member", detail: "admin → member" }],
      });
      await eraseAccountTraces(db, { _id: JAN, username: "member", email: "" });
      expect(rows("InstanceAuditLog")[0]).toMatchObject({ target: LABEL, detail: "admin → member" });
    });
  });

  describe("a board's access log", () => {
    const seed = () =>
      memoryDb({
        ProjectAuditLog: [
          { _id: "p1", action: "member_added", detail: "jan: no access → member" },
          { _id: "p2", action: "member_role_changed", detail: "bob: viewer → editor" },
          { _id: "p3", action: "member_invited", detail: "jan@example.com: invited as member" },
          { _id: "p4", action: "settings_updated", detail: "jan: not a person here" },
          { _id: "p5", action: "member_invitation_removed", detail: "jan@example.com: invitation to this board withdrawn" },
        ],
      });

    it("rewrites who a grant was about, and nothing else on the line", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, USER);
      expect(rows("ProjectAuditLog").map((r) => r.detail)).toEqual([
        `${LABEL}: no access → member`,
        "bob: viewer → editor",
        `${LABEL}: invited as member`,
        "jan: not a person here",
        `${LABEL}: invitation to this board withdrawn`,
      ]);
    });

    it("does not take a role for a person: an account called viewer leaves other people's lines alone", async () => {
      const { db, rows } = seed();
      await eraseAccountTraces(db, { _id: JAN, username: "viewer", email: "" });
      expect(rows("ProjectAuditLog").map((r) => r.detail)).toEqual([
        "jan: no access → member",
        "bob: viewer → editor",
        "jan@example.com: invited as member",
        "jan: not a person here",
        "jan@example.com: invitation to this board withdrawn",
      ]);
    });
  });

  it("releases the person's machines only: disabled, ownerless, with a credential nobody holds and no name of theirs", async () => {
    const { db, rows } = memoryDb({
      Worker: [
        { _id: "w1", owner: JAN, name: "MacBook", identity: "m1", enabled: true, credentialHash: "held" },
        { _id: "w2", owner: OLA, name: "Studio", identity: "m2", enabled: true, credentialHash: "held" },
      ],
      User: [
        { _id: "m1", fullName: "Jan Kowalski · MacBook" },
        { _id: "m2", fullName: "Ola Nowak · Studio" },
      ],
    });
    await eraseAccountTraces(db, USER);
    const [mine, theirs] = rows("Worker");
    expect(mine).toMatchObject({ owner: null, enabled: false });
    expect(mine.credentialHash).not.toBe("held");
    expect(theirs).toMatchObject({ owner: OLA, enabled: true, credentialHash: "held" });
    expect(rows("User").map((u) => u.fullName)).toEqual(["MacBook", "Ola Nowak · Studio"]);
  });
});

describe("what a person authored for the machines", () => {
  const seed = () =>
    memoryDb({
      Agent: [
        { _id: "g1", scope: "user", owner: JAN, name: "Jan's refactorer" },
        { _id: "g2", scope: "user", owner: OLA, name: "Ola's agent" },
        { _id: "g3", scope: "project", owner: null, project: "p1", name: "Release agent" },
        { _id: "g4", scope: "global", owner: null, name: "Default" },
      ],
      Task: [
        { _id: "t1", agent: "g1", assignee: JAN, watchers: [] },
        { _id: "t2", agent: "g2", assignee: OLA, watchers: [] },
        { _id: "t3", agent: "g3", assignee: JAN, watchers: [] },
      ],
      AgentRun: [
        { _id: "r1", agent: "g1", agentName: "Jan's refactorer", detail: "ok" },
        { _id: "r2", agent: "g2", agentName: "Ola's agent", detail: "ok" },
      ],
      AgentBlock: [
        { _id: "b1", key: "mine", createdBy: JAN },
        { _id: "b2", key: "theirs", createdBy: OLA },
        { _id: "b3", key: "builtin", createdBy: null },
      ],
    });

  it("deletes the person's personal agents and keeps every other agent", async () => {
    const { db, rows } = seed();
    await eraseAccountTraces(db, USER);
    expect(rows("Agent").map((a) => a._id)).toEqual(["g2", "g3", "g4"]);
  });

  it("takes the deleted agent off the tasks that named it, whoever else those tasks name", async () => {
    const { db, rows } = seed();
    await eraseAccountTraces(db, USER);
    expect(rows("Task").map((t) => [t._id, t.agent])).toEqual([
      ["t1", null],
      ["t2", "g2"],
      ["t3", "g3"],
    ]);
  });

  it("keeps a run in the history but not the name the person gave the agent", async () => {
    const { db, rows } = seed();
    await eraseAccountTraces(db, USER);
    expect(rows("AgentRun")).toEqual([
      { _id: "r1", agent: null, agentName: DELETED_AGENT, detail: "ok" },
      { _id: "r2", agent: "g2", agentName: "Ola's agent", detail: "ok" },
    ]);
  });

  it("hands a block the person created to nobody and keeps the block", async () => {
    const { db, rows } = seed();
    await eraseAccountTraces(db, USER);
    expect(rows("AgentBlock").map((b) => [b.key, b.createdBy])).toEqual([
      ["mine", null],
      ["theirs", OLA],
      ["builtin", null],
    ]);
  });

  it("rewrites the agent's name in task history, only on tasks the person pointed it at", async () => {
    const { db, rows } = memoryDb({
      Agent: [
        { _id: "g1", scope: "user", owner: JAN, name: "Default" },
        { _id: "g4", scope: "global", owner: null, name: "Default" },
      ],
      ActivityLog: [
        { _id: "h1", task: "t1", user: JAN, field: "agent", oldValue: "", newValue: "Default" },
        { _id: "h2", task: "t1", user: OLA, field: "agent", oldValue: "Default", newValue: "" },
        { _id: "h3", task: "t2", user: OLA, field: "agent", oldValue: "", newValue: "Default" },
        { _id: "h4", task: "t1", user: JAN, field: "title", oldValue: "Default", newValue: "x" },
        { _id: "h5", task: "t1", user: JAN, field: "agent", oldValue: "", newValue: "g1" },
      ],
    });
    await eraseAccountTraces(db, USER);
    expect(rows("ActivityLog").map((r) => [r._id, r.oldValue, r.newValue])).toEqual([
      ["h1", "", DELETED_AGENT],
      ["h2", DELETED_AGENT, ""],
      ["h3", "", "Default"],
      ["h4", "Default", "x"],
      ["h5", "", DELETED_AGENT],
    ]);
  });

  it("leaves history alone when the person had no personal agent", async () => {
    const { db, rows } = memoryDb({
      ActivityLog: [{ _id: "h1", task: "t1", user: JAN, field: "agent", oldValue: "", newValue: "Default" }],
    });
    await eraseAccountTraces(db, USER);
    expect(rows("ActivityLog")[0].newValue).toBe("Default");
  });

  it("changes tasks, runs and blocks without moving their edit time", async () => {
    const { db, calls } = seed();
    await eraseAccountTraces(db, USER);
    for (const model of ["Task", "AgentRun", "AgentBlock"]) {
      const writes = calls.filter((c) => c.model === model && c.op === "updateMany");
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((c) => (c.options as { timestamps?: boolean } | undefined)?.timestamps === false)).toBe(true);
    }
  });

  it("releases the machines last, so a failure before that leaves a live account its machines", async () => {
    const { db, calls } = memoryDb({ Worker: [{ _id: "w1", owner: JAN, name: "MacBook", identity: "m1" }], User: [{ _id: "m1", fullName: "Jan · MacBook" }] });
    await eraseAccountTraces(db, USER);
    const lastScrub = calls.map((c) => c.model).lastIndexOf("ProjectAuditLog");
    const release = calls.findIndex((c) => c.model === "Worker" && c.op === "updateOne");
    expect(lastScrub).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(lastScrub);
  });

  it("renames the machine's own account before it lets the machine go, so a stop between the two is found again", async () => {
    const { db, calls } = memoryDb({ Worker: [{ _id: "w1", owner: JAN, name: "MacBook", identity: "m1" }], User: [{ _id: "m1", fullName: "Jan · MacBook" }] });
    await eraseAccountTraces(db, USER);
    const rename = calls.findIndex((c) => c.model === "User" && c.op === "updateOne");
    const release = calls.findIndex((c) => c.model === "Worker" && c.op === "updateOne");
    expect(rename).toBeGreaterThan(-1);
    expect(rename).toBeLessThan(release);
  });

  it("does nothing a second time", async () => {
    const { db, rows } = seed();
    await eraseAccountTraces(db, USER);
    const first = JSON.stringify([rows("Agent"), rows("Task"), rows("AgentRun"), rows("AgentBlock")]);
    await eraseAccountTraces(db, USER);
    expect(JSON.stringify([rows("Agent"), rows("Task"), rows("AgentRun"), rows("AgentBlock")])).toBe(first);
  });
});

describe("references an earlier deletion left behind", () => {
  const GONE = new Types.ObjectId();
  const ALSO_GONE = new Types.ObjectId();
  const HERE = new Types.ObjectId();

  it("names an id nobody holds an account for, once, with where it was found", async () => {
    const { db } = memoryDb({
      User: [{ _id: HERE }],
      Task: [
        { _id: "t1", assignee: GONE, assignedBy: HERE, pmAssignedFor: null, watchers: [GONE, HERE] },
        { _id: "t2", assignee: HERE, assignedBy: ALSO_GONE, pmAssignedFor: null, watchers: [] },
      ],
    });
    const orphans = await findOrphanReferences(db);
    expect(orphans.ids.sort()).toEqual([String(GONE), String(ALSO_GONE)].sort());
    expect(orphans.bySource).toMatchObject({ "Task.assignee": 1, "Task.watchers": 1, "Task.assignedBy": 1 });
    expect(orphans.userCount).toBe(1);
  });

  it("clears them from the tasks and leaves a live account's alone", async () => {
    const { db, rows } = memoryDb({
      User: [{ _id: HERE }],
      Task: [{ _id: "t1", assignee: GONE, assignedBy: HERE, pmAssignedFor: GONE, watchers: [GONE, HERE] }],
    });
    const erased = await eraseOrphanReferences(db, await findOrphanReferences(db));
    expect(erased).toBe(1);
    expect(rows("Task")).toEqual([{ _id: "t1", assignee: null, assignedBy: HERE, pmAssignedFor: null, watchers: [HERE] }]);
  });

  it.each([...ORPHAN_SOURCES])("finds an id that only %s still names", async (model, field) => {
    const { db } = memoryDb({
      User: [{ _id: HERE }],
      [model]: [{ _id: "x", [field]: field === "watchers" ? [GONE, HERE] : GONE }],
    });
    const orphans = await findOrphanReferences(db);
    expect(orphans.ids).toEqual([String(GONE)]);
    expect(orphans.bySource).toEqual({ [`${model}.${field}`]: 1 });
  });

  it("covers every model the erasure of one account reaches by id", () => {
    expect(ORPHAN_SOURCES.map(([model]) => model)).toEqual(
      expect.arrayContaining(["Task", "Notification", "PmMessage", "OAuthConsent", "Invitation", "Worker", "Agent", "AgentBlock"])
    );
  });

  it("ignores a value that is not an object id rather than failing on it", async () => {
    const { db, rows } = memoryDb({
      User: [{ _id: HERE }],
      Task: [{ _id: "t1", assignee: "not-an-id", assignedBy: String(GONE), pmAssignedFor: null, watchers: [] }],
    });
    const orphans = await findOrphanReferences(db);
    expect(orphans.ids).toEqual([]);
    expect(await eraseOrphanReferences(db, orphans)).toBe(0);
    expect(rows("Task")[0].assignee).toBe("not-an-id");
  });

  it("removes what an orphan authored and was sent, the way a deletion does, and releases its machines", async () => {
    const { db, rows } = memoryDb({
      User: [{ _id: HERE }, { _id: "m1", fullName: "Gone · Studio" }],
      Agent: [{ _id: "a1", scope: "user", owner: GONE, name: "Gone's agent" }, { _id: "a2", scope: "global", owner: null, name: "Default" }],
      AgentRun: [{ _id: "r1", agent: "a1", agentName: "Gone's agent" }],
      AgentBlock: [{ _id: "b1", key: "k", createdBy: GONE }],
      Notification: [{ _id: "n1", recipient: GONE, actor: HERE }, { _id: "n2", recipient: HERE, actor: HERE }],
      Task: [{ _id: "t1", agent: "a1", assignee: HERE, watchers: [] }],
      Worker: [{ _id: "w1", owner: GONE, name: "Studio", identity: "m1", enabled: true, credentialHash: "held" }],
    });
    const orphans = await findOrphanReferences(db);
    expect(await eraseOrphanReferences(db, orphans)).toBe(1);

    expect(rows("Agent").map((a) => a._id)).toEqual(["a2"]);
    expect(rows("AgentRun")[0]).toMatchObject({ agent: null, agentName: DELETED_AGENT });
    expect(rows("AgentBlock")[0].createdBy).toBeNull();
    expect(rows("Notification").map((n) => n._id)).toEqual(["n2"]);
    expect(rows("Task")[0].agent).toBeNull();
    expect(rows("Worker")[0]).toMatchObject({ owner: null, enabled: false });
    expect(rows("User").find((u) => u._id === "m1")?.fullName).toBe("Studio");
  });

  it("skips an id whose account exists by the time it is erased", async () => {
    const { db, rows, store } = memoryDb({
      User: [{ _id: HERE }],
      Task: [{ _id: "t1", assignee: GONE, assignedBy: null, pmAssignedFor: null, watchers: [] }],
    });
    const orphans = await findOrphanReferences(db);
    expect(orphans.ids).toEqual([String(GONE)]);
    store.User.push({ _id: GONE });
    expect(await eraseOrphanReferences(db, orphans)).toBe(0);
    expect(rows("Task")[0].assignee).toBe(GONE);
  });

  it("refuses to run against a database with no accounts in it", async () => {
    const { db } = memoryDb({ User: [], Task: [{ _id: "t1", assignee: GONE, watchers: [] }] });
    await expect(eraseOrphanReferences(db, await findOrphanReferences(db))).rejects.toThrow(/no users/);
  });
});
