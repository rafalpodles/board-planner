import { describe, it, expect, vi, beforeEach } from "vitest";

const PROJECT = "507f1f77bcf86cd799439021";
const OTHER_PROJECT = "507f1f77bcf86cd799439022";

const createNotifications = vi.fn().mockResolvedValue(undefined);
const userFind = vi.fn();
const grantFind = vi.fn();

/** Everybody in the collection, per test, as stored. The mock applies the real filter to them. */
let stored: Record<string, unknown>[] = [];
/** Who holds a grant on PROJECT. */
let granted: string[] = [];

/**
 * Enough of a query engine to answer the filter this module actually sends, and no more. It
 * honours $and/$or/$elemMatch and dotted paths, so a query that forgot the access half, or looked
 * up the wrong project's override, returns the wrong people here rather than passing anyway.
 */
function valueAt(doc: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, doc);
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") return (condition as Record<string, unknown>[]).every((f) => matches(doc, f));
    if (key === "$or") return (condition as Record<string, unknown>[]).some((f) => matches(doc, f));

    const actual = key === "_id" ? doc._id : valueAt(doc, key);

    if (condition && typeof condition === "object") {
      const clause = condition as Record<string, unknown>;
      if ("$in" in clause) {
        return (clause.$in as unknown[]).map(String).includes(String(actual));
      }
      if ("$elemMatch" in clause) {
        const inner = clause.$elemMatch as Record<string, unknown>;
        return (Array.isArray(actual) ? actual : []).some((entry) =>
          matches(entry as Record<string, unknown>, inner)
        );
      }
    }
    return String(actual) === String(condition);
  });
}

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/grant", () => ({
  Grant: {
    find: (...a: unknown[]) => {
      grantFind(...a);
      const filter = a[0] as { objectType?: string; object?: string };
      const rows =
        filter?.objectType === "project" && filter?.object === PROJECT
          ? granted.map((subject) => ({ subject }))
          : [];
      return { select: () => ({ lean: async () => rows }) };
    },
  },
}));
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) => {
      userFind(...a);
      const filter = a[0] as Record<string, unknown>;
      const hits = stored.filter((doc) => matches(doc, filter));
      // Sorted by _id the way the query asks, so the cap below takes a defined set
      hits.sort((x, y) => String(x._id).localeCompare(String(y._id)));
      let limit = hits.length;
      const chain = {
        sort: () => chain,
        limit: (n: number) => {
          limit = n;
          return chain;
        },
        lean: async () => hits.slice(0, limit),
      };
      return chain;
    },
  },
}));
vi.mock("@/lib/in-app-notifications", () => ({
  createNotifications: (...a: unknown[]) => createNotifications(...a),
}));

const { boardFeedSubscribers, notifyBoardFeed, BOARD_FEED_FANOUT_LIMIT } = await import(
  "@/lib/board-feed"
);

const id = (n: number) => `507f1f77bcf86cd7994${String(n).padStart(5, "0")}`;

const row = (over: Partial<Record<"inApp" | "email" | "chat", boolean>> = {}) => ({
  inApp: false,
  email: false,
  chat: false,
  ...over,
});

/** Somebody who saved the settings screen — a stored grid, so no legacy fallback applies. */
function member(
  n: number,
  over: {
    defaults?: Record<string, unknown>;
    projects?: { project: string; matrix: Record<string, unknown> }[];
    chat?: { kind?: string; webhookUrl?: string };
  } = {}
) {
  return {
    _id: id(n),
    role: "member",
    emailNotifications: false,
    notifications: {
      defaults: { task_created: row(), ...over.defaults },
      projects: over.projects ?? [],
      chat: over.chat ?? { kind: "", webhookUrl: "" },
    },
  };
}

beforeEach(() => {
  createNotifications.mockClear();
  userFind.mockClear();
  grantFind.mockClear();
  stored = [];
  granted = [];
});

describe("who hears that a task was created", () => {
  it("picks the member who ticked the row globally", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([id(1)]);
  });

  // The control the checklist asks for, and the whole point of the row: everybody else on the
  // board is in the audience query and must fall out of it on the tick alone.
  it("leaves out a member of the same board who ticked nothing", async () => {
    stored = [
      member(1, { defaults: { task_created: row({ inApp: true }) } }),
      member(2),
    ];
    granted = [id(1), id(2)];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([id(1)]);
  });

  // An account that has never opened the settings screen has no stored grid at all, and the
  // legacy fallback rings the bell for every other row. Adding this one to it would subscribe
  // every existing account on the instance to the firehose.
  it("leaves out an account that predates the grid", async () => {
    stored = [{ _id: id(3), role: "member", emailNotifications: true }];
    granted = [id(3)];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([]);
  });

  it("picks somebody who ticked it for this board only", async () => {
    stored = [
      member(1, {
        projects: [{ project: PROJECT, matrix: { task_created: row({ email: true }) } }],
      }),
    ];
    granted = [id(1)];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([id(1)]);
  });

  it("does not pick somebody who ticked it for a different board", async () => {
    stored = [
      member(1, {
        projects: [{ project: OTHER_PROJECT, matrix: { task_created: row({ inApp: true }) } }],
      }),
    ];
    granted = [id(1)];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([]);
  });

  // The case no query over paths can express: the candidate matches on the global grid, and the
  // project's own grid — which is the one in force — switches the row off. Only resolveChannels
  // knows that, which is why it and not the query makes the decision.
  it("obeys an override that switches the row off for this board", async () => {
    stored = [
      member(1, {
        defaults: { task_created: row({ inApp: true }) },
        projects: [{ project: PROJECT, matrix: { task_created: row() } }],
      }),
    ];
    granted = [id(1)];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([]);
  });

  // Chat is not stored as deliverable, it is derived from the connection. A tick with no webhook
  // resolves to nothing, so it is not a subscription either.
  it("does not count a chat tick with nothing connected as opting in", async () => {
    stored = [member(1, { defaults: { task_created: row({ chat: true }) } })];
    granted = [id(1)];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([]);

    stored = [
      member(1, {
        defaults: { task_created: row({ chat: true }) },
        chat: { kind: "slack", webhookUrl: "https://hooks.example.com/x" },
      }),
    ];
    expect(await boardFeedSubscribers(PROJECT)).toEqual([id(1)]);
  });
});

describe("who is in the audience at all", () => {
  // Access has to be part of the *selection*, not only of the delivery filter downstream: with
  // the cap applied to a list that includes people who cannot reach the board, an instance full
  // of subscribers to other projects can push this board's own members past the limit.
  it("does not select a subscriber with no standing on the board", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([]);
  });

  it("selects an instance admin, who reaches the board without a grant row", async () => {
    stored = [
      { ...member(1, { defaults: { task_created: row({ inApp: true }) } }), role: "admin" },
    ];
    granted = [];

    expect(await boardFeedSubscribers(PROJECT)).toEqual([id(1)]);
  });

  it("asks about the board the task was created on", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    await boardFeedSubscribers(PROJECT);

    expect(grantFind).toHaveBeenCalledWith(
      expect.objectContaining({ objectType: "project", object: PROJECT })
    );
  });

  it("reads nothing at all when the project is not an id", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    expect(await boardFeedSubscribers("BP")).toEqual([]);
    expect(userFind).not.toHaveBeenCalled();
  });
});

describe("a board with more subscribers than the cap", () => {
  function crowd(size: number) {
    return Array.from({ length: size }, (_, i) =>
      member(i + 1, { defaults: { task_created: row({ inApp: true }) } })
    );
  }

  it("tells the first BOARD_FEED_FANOUT_LIMIT of them and no more", async () => {
    stored = crowd(BOARD_FEED_FANOUT_LIMIT + 25);
    granted = stored.map((u) => String(u._id));

    const told = await boardFeedSubscribers(PROJECT);

    expect(told).toHaveLength(BOARD_FEED_FANOUT_LIMIT);
    expect(told[0]).toBe(id(1));
  });

  // A cap nobody is told about reads as "everyone was notified" in every log this leaves behind
  it("says out loud that it left people out", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    stored = crowd(BOARD_FEED_FANOUT_LIMIT + 1);
    granted = stored.map((u) => String(u._id));

    await boardFeedSubscribers(PROJECT);

    expect(reported).toHaveBeenCalledWith(expect.stringContaining(String(BOARD_FEED_FANOUT_LIMIT)));
    reported.mockRestore();
  });

  // The cap has to be spent on people who subscribed. Selecting the whole audience and sifting it
  // afterwards passes every other test here — and quietly drops the one subscriber on a board
  // whose membership is larger than the limit, which is the board the cap exists for.
  it("still reaches the one subscriber behind a board full of people who are not", async () => {
    const bystanders = Array.from({ length: BOARD_FEED_FANOUT_LIMIT }, (_, i) => member(i + 1));
    const subscriber = member(BOARD_FEED_FANOUT_LIMIT + 1, {
      defaults: { task_created: row({ inApp: true }) },
    });
    stored = [...bystanders, subscriber];
    granted = stored.map((u) => String(u._id));

    expect(await boardFeedSubscribers(PROJECT)).toEqual([String(subscriber._id)]);
  });

  it("stays quiet when everybody fitted", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    stored = crowd(3);
    granted = stored.map((u) => String(u._id));

    await boardFeedSubscribers(PROJECT);

    expect(reported).not.toHaveBeenCalled();
    reported.mockRestore();
  });
});

describe("dispatching it", () => {
  const params = {
    taskId: "507f1f77bcf86cd799439030",
    projectId: PROJECT,
    actorId: "507f1f77bcf86cd799439031",
    title: "New task BP-7 in Board Planner",
    body: "Bound the fan-out",
  };

  it("hands the subscribers to the notification writer under the right type", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    await notifyBoardFeed(params);

    expect(createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task_created", recipientIds: [id(1)] })
    );
  });

  it("writes nothing when nobody subscribed", async () => {
    stored = [member(1)];
    granted = [id(1)];

    await notifyBoardFeed(params);

    expect(createNotifications).not.toHaveBeenCalled();
  });

  // Nothing awaits this: task creation has already answered the request. A rejection escaping
  // here is an unhandled rejection, which ends the process rather than losing one notification.
  it("does not reject when the subscriber lookup fails", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    userFind.mockImplementationOnce(() => {
      throw new Error("mongo is having a bad afternoon");
    });

    await expect(notifyBoardFeed(params)).resolves.toBeUndefined();
    reported.mockRestore();
  });
});
