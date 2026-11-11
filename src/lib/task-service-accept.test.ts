import { describe, it, expect, vi, beforeEach } from "vitest";
import sift from "sift";

const logActivity = vi.fn();
const pmUserId = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/activity", () => ({ logActivity, logActivities: vi.fn() }));
vi.mock("@/lib/pm/pm-user", () => ({ pmUserId }));

const { acceptHandover, NOT_THE_ASSIGNEE, CHANGED_HANDS } = await import("./task-service");

const PROJECT = "p1";
const TASK = "t1";
const BARTEK = "u-bartek";
const ANIA = "u-ania";
const CELINA = "u-celina";
const PM = "u-pm";

type Doc = Record<string, unknown>;

/**
 * One task in a store, matched by MongoDB's own query semantics: the compare-and-set is the whole
 * point, so a fake that matched by hand could agree with a filter the database would reject.
 * `beforeWrite` lands between the read and the write, which is where a concurrent reassignment does.
 */
function fakeDb(task: Doc, { beforeWrite }: { beforeWrite?: (doc: Doc) => void } = {}) {
  const doc: Doc = { _id: TASK, project: PROJECT, ...task };
  const query = (value: Doc | null) => ({
    lean: async () => (value ? { ...value } : null),
    populate: async () => (value ? { ...value } : null),
    then: (resolve: (v: unknown) => void) => resolve(value ? { ...value } : null),
  });
  const writes: Doc[] = [];
  const db = {
    Task: {
      findOne: vi.fn((filter: Doc) => query(sift(filter)(doc) ? doc : null)),
      findOneAndUpdate: vi.fn((filter: Doc, update: { $set: Doc }) => {
        beforeWrite?.(doc);
        const hit = sift(filter)(doc);
        if (hit) {
          Object.assign(doc, update.$set);
          writes.push(update.$set);
        }
        return query(hit ? doc : null);
      }),
    },
    User: {
      findById: vi.fn((id: string) => ({ lean: async () => ({ username: id.replace("u-", "") }) })),
    },
  };
  return { db, doc, writes };
}

const accept = (db: unknown, actor = BARTEK) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  acceptHandover(db as any, PROJECT, TASK, actor);

beforeEach(() => {
  logActivity.mockReset();
  pmUserId.mockReset().mockResolvedValue(PM);
});

describe("acceptHandover", () => {
  it("records the assignee as the one who handed it over, and says who had", async () => {
    const { db, doc } = fakeDb({ assignee: BARTEK, assignedBy: ANIA, pmAssignedFor: null });

    const result = await accept(db);

    expect(result.ok).toBe(true);
    expect(doc.assignedBy).toBe(BARTEK);
    expect(doc.pmAssignedFor).toBeNull();
    expect(logActivity).toHaveBeenCalledWith(db, PROJECT, TASK, BARTEK, "handover_accepted", "assignedBy", "ania", "");
  });

  it("takes on a hand-over the PM made on somebody else's instruction", async () => {
    const { db, doc } = fakeDb({ assignee: BARTEK, assignedBy: PM, pmAssignedFor: ANIA });

    expect((await accept(db)).ok).toBe(true);
    expect(doc.assignedBy).toBe(BARTEK);
    expect(doc.pmAssignedFor).toBeNull();
  });

  it("records an assigner on a task stored before there was one", async () => {
    const { db, doc } = fakeDb({ assignee: BARTEK });

    expect((await accept(db)).ok).toBe(true);
    expect(doc.assignedBy).toBe(BARTEK);
    expect(logActivity).toHaveBeenCalledWith(db, PROJECT, TASK, BARTEK, "handover_accepted", "assignedBy", "", "");
  });

  it("refuses anybody who is not the assignee, the one who handed it over included", async () => {
    const { db, writes } = fakeDb({ assignee: BARTEK, assignedBy: ANIA });

    const result = await accept(db, ANIA);

    expect(result).toEqual({ ok: false, error: NOT_THE_ASSIGNEE, status: 403 });
    expect(writes).toHaveLength(0);
  });

  it("writes nothing for a task its assignee handed to themselves", async () => {
    const { db, writes } = fakeDb({ assignee: BARTEK, assignedBy: BARTEK });

    expect((await accept(db)).ok).toBe(true);
    expect(writes).toHaveLength(0);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("writes nothing for a PM hand-over the assignee asked for", async () => {
    const { db, writes } = fakeDb({ assignee: BARTEK, assignedBy: PM, pmAssignedFor: BARTEK });

    expect((await accept(db)).ok).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("refuses when the task is handed to somebody else between the read and the write", async () => {
    const { db, doc, writes } = fakeDb(
      { assignee: BARTEK, assignedBy: ANIA },
      { beforeWrite: (d) => Object.assign(d, { assignee: CELINA, assignedBy: ANIA }) }
    );

    const result = await accept(db);

    expect(result).toEqual({ ok: false, error: CHANGED_HANDS, status: 409 });
    expect(writes).toHaveLength(0);
    expect(doc.assignedBy).toBe(ANIA);
  });

  it("refuses when somebody else re-hands it to the same person in between", async () => {
    const { db, writes } = fakeDb(
      { assignee: BARTEK, assignedBy: ANIA },
      { beforeWrite: (d) => Object.assign(d, { assignedBy: CELINA }) }
    );

    expect(await accept(db)).toEqual({ ok: false, error: CHANGED_HANDS, status: 409 });
    expect(writes).toHaveLength(0);
  });

  it("answers as accepted when a second click landed first", async () => {
    const { db } = fakeDb(
      { assignee: BARTEK, assignedBy: ANIA },
      { beforeWrite: (d) => Object.assign(d, { assignedBy: BARTEK }) }
    );

    expect((await accept(db)).ok).toBe(true);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("answers 404 for a task that is not on this board", async () => {
    const { db } = fakeDb({ project: "elsewhere", assignee: BARTEK, assignedBy: ANIA });

    expect(await accept(db)).toMatchObject({ ok: false, status: 404 });
  });
});
