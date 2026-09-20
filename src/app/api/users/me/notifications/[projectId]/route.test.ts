import { describe, it, expect, vi, beforeEach } from "vitest";
import { NOTIFICATION_TYPES } from "@/types";

const getAuthUser = vi.fn();
const check = vi.fn();
const userFindOneAndUpdate = vi.fn();
const userFindByIdAndUpdate = vi.fn();
const userFindById = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/user", () => ({
  User: {
    findOneAndUpdate: userFindOneAndUpdate,
    findByIdAndUpdate: userFindByIdAndUpdate,
    findById: userFindById,
  },
}));

const { PUT, DELETE } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const ME = "507f1f77bcf86cd799439031";
const MAX_OVERRIDES = 200;

function call(verb: typeof PUT, body?: unknown) {
  return verb(
    new Request(`http://localhost/api/users/me/notifications/${PROJECT_ID}`, {
      method: "PUT",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID }) }
  );
}

/** A grid with one row ticked, which is enough to tell "stored" from "normalised away". */
const oneRowTicked = { [NOTIFICATION_TYPES[0]]: { inApp: true, email: false, chat: false } };

/**
 * What the two statements answered, in order: the in-place update, then the insert.
 *
 * Reset first — these are `Once` queues, and a test calling this after the default in beforeEach
 * would otherwise queue behind it and read the default's answers instead of its own.
 */
function writes(inPlace: unknown, inserted: unknown) {
  userFindOneAndUpdate.mockReset();
  userFindOneAndUpdate.mockResolvedValueOnce(inPlace).mockResolvedValueOnce(inserted);
}

/** How many overrides the follow-up read finds, once neither write landed. */
function alreadyHolds(count: number) {
  userFindById.mockReturnValue({
    lean: async () => ({
      notifications: { projects: Array.from({ length: count }, () => ({ project: "x" })) },
    }),
  });
}

const update = (nth: number) => userFindOneAndUpdate.mock.calls[nth]?.[1];
const filter = (nth: number) => userFindOneAndUpdate.mock.calls[nth]?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: ME, role: "member", viaMachineCredential: false });
  check.mockResolvedValue(true);
  userFindByIdAndUpdate.mockResolvedValue({});
  writes({ _id: ME }, null);
  alreadyHolds(0);
});

describe("PUT /api/users/me/notifications/:projectId", () => {
  it("updates the row in place when this person already overrides the project", async () => {
    const res = await call(PUT, { matrix: oneRowTicked });

    expect(res.status).toBe(200);
    expect(filter(0)).toEqual({ _id: ME, "notifications.projects.project": PROJECT_ID });
    expect(update(0)).toEqual({
      $set: { "notifications.projects.$.matrix": expect.objectContaining(oneRowTicked) },
    });
    expect(userFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("inserts a row when there is no override yet", async () => {
    writes(null, { _id: ME });

    const res = await call(PUT, { matrix: oneRowTicked });

    expect(res.status).toBe(200);
    expect(update(1)).toEqual({
      $push: {
        "notifications.projects": {
          project: PROJECT_ID,
          matrix: expect.objectContaining(oneRowTicked),
        },
      },
    });
  });

  /**
   * The ceiling lives in the insert's own filter rather than in a count read beforehand, which
   * bounded nothing under concurrency: every racer saw the same pre-write length and every one of
   * them passed. The `$ne` in the same filter is the other half — two tabs cannot leave two rows
   * for one project.
   */
  it("bounds the array and refuses a second row inside the insert's filter", async () => {
    writes(null, { _id: ME });

    await call(PUT, { matrix: oneRowTicked });

    expect(filter(1)).toEqual({
      _id: ME,
      "notifications.projects.project": { $ne: PROJECT_ID },
      $expr: {
        $lt: [{ $size: { $ifNull: ["$notifications.projects", []] } }, MAX_OVERRIDES],
      },
    });
    expect(userFindById).not.toHaveBeenCalled();
  });

  /**
   * Nothing was written and the two reasons need different words. Reading once to tell them apart
   * is worth it: answering {ok:true} for either would report a save that did not happen.
   */
  it("says the ceiling is reached when that is why nothing was written", async () => {
    writes(null, null);
    alreadyHolds(MAX_OVERRIDES);

    const res = await call(PUT, { matrix: oneRowTicked });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `A person may tune at most ${MAX_OVERRIDES} projects`,
    });
  });

  it("says somebody raced when the array still has room", async () => {
    writes(null, null);
    alreadyHolds(3);

    const res = await call(PUT, { matrix: oneRowTicked });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("at the same moment");
  });

  it("stores a full grid even when the body carries none", async () => {
    await call(PUT, {});

    const stored = (update(0) as { $set: Record<string, Record<string, unknown>> }).$set[
      "notifications.projects.$.matrix"
    ];
    expect(Object.keys(stored)).toEqual([...NOTIFICATION_TYPES]);
  });

  // A tick that is not literally `true` is off, so a string, a 1 or a missing key all store false
  // rather than something a later read has to interpret.
  it("normalises anything that is not true to false", async () => {
    await call(PUT, {
      matrix: { [NOTIFICATION_TYPES[0]]: { inApp: "yes", email: 1, chat: null } },
    });

    const stored = (update(0) as { $set: Record<string, Record<string, unknown>> }).$set[
      "notifications.projects.$.matrix"
    ];
    expect(stored[NOTIFICATION_TYPES[0]]).toEqual({ inApp: false, email: false, chat: false });
  });

  it("survives a body that is not JSON at all", async () => {
    const res = await PUT(
      new Request(`http://localhost/api/users/me/notifications/${PROJECT_ID}`, {
        method: "PUT",
        body: "{not json",
      }),
      { params: Promise.resolve({ projectId: PROJECT_ID }) }
    );

    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/users/me/notifications/:projectId", () => {
  // Removing the row IS switching the override off; there is no separate flag to clear.
  it("pulls the row for this project", async () => {
    const res = await call(DELETE);

    expect(res.status).toBe(200);
    expect(userFindByIdAndUpdate).toHaveBeenCalledWith(ME, {
      $pull: { "notifications.projects": { project: PROJECT_ID } },
    });
  });
});

describe("the gates on both verbs", () => {
  /**
   * Removing an override widens delivery just as surely as ticking a box does — the reader falls
   * back to the global grid — so gating only the write left the other half open to a token.
   */
  it("refuses a machine credential on the write and on the removal alike", async () => {
    getAuthUser.mockResolvedValue({ _id: ME, role: "member", viaMachineCredential: true });

    const put = await call(PUT, { matrix: oneRowTicked });
    const del = await call(DELETE);

    expect(put.status).toBe(403);
    expect(del.status).toBe(403);
    expect(await put.json()).toEqual({ error: "This action requires an interactive session" });
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
    expect(userFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("401s with no credential", async () => {
    getAuthUser.mockResolvedValue(null);

    expect((await call(PUT, { matrix: oneRowTicked })).status).toBe(401);
    expect((await call(DELETE)).status).toBe(401);
  });

  /**
   * Personal settings behind withProjectAccess rather than withProjectOwner: every member has one.
   * The gate is there to stop overrides being stored for projects the caller cannot see.
   */
  it("403s for a project this person cannot reach", async () => {
    check.mockResolvedValue(false);

    expect((await call(PUT, { matrix: oneRowTicked })).status).toBe(403);
    expect((await call(DELETE)).status).toBe(403);
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
    expect(userFindByIdAndUpdate).not.toHaveBeenCalled();
  });
});
