import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
 * honours $and/$or/$nor/$elemMatch/$in (regexes included)/$ne/$nin/$gt/$type, several operators on
 * one field, and dotted paths, so a query that forgot the access half, or looked up the wrong
 * project's override, returns the wrong people here rather than passing anyway.
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
    if (key === "$nor") return !(condition as Record<string, unknown>[]).some((f) => matches(doc, f));

    const actual = key === "_id" ? doc._id : valueAt(doc, key);

    if (condition && typeof condition === "object" && Object.keys(condition).some((k) => k.startsWith("$"))) {
      return Object.entries(condition as Record<string, unknown>).every(([op, operand]) =>
        satisfies(actual, op, operand)
      );
    }
    // As Mongo reads it: equal to null is null or no such field at all
    if (condition === null) return actual === null || actual === undefined;
    return String(actual) === String(condition);
  });
}

function satisfies(actual: unknown, op: string, operand: unknown): boolean {
  switch (op) {
    case "$in":
      return (operand as unknown[]).some((v) =>
        v instanceof RegExp ? typeof actual === "string" && v.test(actual) : String(v) === String(actual)
      );
    case "$ne":
      return String(actual) !== String(operand);
    case "$gt":
      return typeof actual === "string" && actual > String(operand);
    case "$type":
      if (operand !== "object") throw new Error(`mock does not model $type ${operand}`);
      return actual !== null && typeof actual === "object" && !Array.isArray(actual);
    case "$nin":
      return !(operand as unknown[]).some((v) =>
        v === null ? actual === null || actual === undefined : String(v) === String(actual)
      );
    case "$elemMatch":
      return (Array.isArray(actual) ? actual : []).some((entry) =>
        matches(entry as Record<string, unknown>, operand as Record<string, unknown>)
      );
    default:
      throw new Error(`mock does not model ${op}`);
  }
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
      const hits = stored
        .map((doc): Record<string, unknown> => ({ organisation: DEFAULT_ORGANISATION_ID, ...doc }))
        .filter((doc) => matches(doc, filter));
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
let mailConfigured = true;
vi.mock("@/lib/email", () => ({ isEmailConfigured: () => mailConfigured }));

const { boardFeedSubscribers, notifyBoardFeed, BOARD_FEED_FANOUT_LIMIT } = await import(
  "@/lib/board-feed"
);
const { encryptSecret } = await import("@/lib/encryption");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");
const db = scopedToDefaultOrganisation();

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
  mailConfigured = true;
});

describe("who hears that a task was created", () => {
  it("picks the member who ticked the row globally", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
  });

  // The control the checklist asks for, and the whole point of the row: everybody else on the
  // board is in the audience query and must fall out of it on the tick alone.
  it("leaves out a member of the same board who ticked nothing", async () => {
    stored = [
      member(1, { defaults: { task_created: row({ inApp: true }) } }),
      member(2),
    ];
    granted = [id(1), id(2)];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
  });

  // An account that has never opened the settings screen has no stored grid at all, and the
  // legacy fallback rings the bell for every other row. Adding this one to it would subscribe
  // every existing account on the instance to the firehose.
  it("leaves out an account that predates the grid", async () => {
    stored = [{ _id: id(3), role: "member", emailNotifications: true }];
    granted = [id(3)];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([]);
  });

  it("picks somebody who ticked it for this board only", async () => {
    stored = [
      {
        ...member(1, {
          projects: [{ project: PROJECT, matrix: { task_created: row({ email: true }) } }],
        }),
        email: "someone@example.com",
      },
    ];
    granted = [id(1)];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
  });

  it("does not pick somebody who ticked it for a different board", async () => {
    stored = [
      member(1, {
        projects: [{ project: OTHER_PROJECT, matrix: { task_created: row({ inApp: true }) } }],
      }),
    ];
    granted = [id(1)];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([]);
  });

  // The candidate's global grid has the row on, and the project's own grid — which is the one in
  // force — switches it off.
  it("obeys an override that switches the row off for this board", async () => {
    stored = [
      member(1, {
        defaults: { task_created: row({ inApp: true }) },
        projects: [{ project: PROJECT, matrix: { task_created: row() } }],
      }),
    ];
    granted = [id(1)];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([]);
  });

  // Chat is not stored as deliverable, it is derived from the connection. A tick with no webhook
  // resolves to nothing, so it is not a subscription either.
  it("does not count a chat tick with nothing connected as opting in", async () => {
    stored = [member(1, { defaults: { task_created: row({ chat: true }) } })];
    granted = [id(1)];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([]);

    stored = [
      member(1, {
        defaults: { task_created: row({ chat: true }) },
        chat: { kind: "slack", webhookUrl: "https://hooks.example.com/x" },
      }),
    ];
    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
  });
});

describe("who is in the audience at all", () => {
  // Access has to be part of the *selection*, not only of the delivery filter downstream: with
  // the cap applied to a list that includes people who cannot reach the board, an instance full
  // of subscribers to other projects can push this board's own members past the limit.
  it("does not select a subscriber with no standing on the board", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([]);
  });

  // BP-832. A deactivated account is told nothing, however it ticked the row
  it("leaves out a deactivated subscriber", async () => {
    stored = [{ ...member(1, { defaults: { task_created: row({ inApp: true }) } }), deactivatedAt: new Date() }];
    granted = [id(1)];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([]);
  });

  it("selects an instance admin, who reaches the board without a grant row", async () => {
    stored = [
      { ...member(1, { defaults: { task_created: row({ inApp: true }) } }), role: "admin" },
    ];
    granted = [];

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
  });

  it("asks about the board the task was created on", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    await boardFeedSubscribers(db, PROJECT);

    expect(grantFind).toHaveBeenCalledWith(
      expect.objectContaining({ objectType: "project", object: PROJECT })
    );
  });

  it("reads nothing at all when the project is not an id", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    expect(await boardFeedSubscribers(db, "BP")).toEqual([]);
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

    const told = await boardFeedSubscribers(db, PROJECT);

    expect(told).toHaveLength(BOARD_FEED_FANOUT_LIMIT);
    expect(told[0]).toBe(id(1));
  });

  // A cap nobody is told about reads as "everyone was notified" in every log this leaves behind
  it("says out loud that it left people out", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    stored = crowd(BOARD_FEED_FANOUT_LIMIT + 1);
    granted = stored.map((u) => String(u._id));

    await boardFeedSubscribers(db, PROJECT);

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

    expect(await boardFeedSubscribers(db, PROJECT)).toEqual([String(subscriber._id)]);
  });

  // BP-705. Each of these matched the query before it carried resolveChannels' whole verdict, was
  // dropped after the limit, and so spent a place the subscriber behind them was refused.
  describe("candidates the grid turns away do not spend the cap", () => {
    const subscriber = () =>
      member(BOARD_FEED_FANOUT_LIMIT + 1, { defaults: { task_created: row({ inApp: true }) } });

    it("an override that switches the row off for this board", async () => {
      const unsubscribedHere = Array.from({ length: BOARD_FEED_FANOUT_LIMIT }, (_, i) =>
        member(i + 1, {
          defaults: { task_created: row({ inApp: true }) },
          projects: [{ project: PROJECT, matrix: { task_created: row() } }],
        })
      );
      stored = [...unsubscribedHere, subscriber()];
      granted = stored.map((u) => String(u._id));

      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(BOARD_FEED_FANOUT_LIMIT + 1)]);
    });

    it("an override that leaves the row unanswered, which for this row is off", async () => {
      const unsubscribedHere = Array.from({ length: BOARD_FEED_FANOUT_LIMIT }, (_, i) =>
        member(i + 1, {
          defaults: { task_created: row({ inApp: true }) },
          projects: [{ project: PROJECT, matrix: {} }],
        })
      );
      stored = [...unsubscribedHere, subscriber()];
      granted = stored.map((u) => String(u._id));

      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(BOARD_FEED_FANOUT_LIMIT + 1)]);
    });

    it("a chat tick with nothing connected, globally or on this board", async () => {
      const unconnected = Array.from({ length: BOARD_FEED_FANOUT_LIMIT }, (_, i) =>
        i % 2
          ? member(i + 1, { defaults: { task_created: row({ chat: true }) } })
          : member(i + 1, {
              projects: [{ project: PROJECT, matrix: { task_created: row({ chat: true }) } }],
              chat: { kind: "slack", webhookUrl: "" },
            })
      );
      stored = [...unconnected, subscriber()];
      granted = stored.map((u) => String(u._id));

      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(BOARD_FEED_FANOUT_LIMIT + 1)]);
    });

    it("a mail tick with no address to send it to", async () => {
      const unreachable = Array.from({ length: BOARD_FEED_FANOUT_LIMIT }, (_, i) =>
        member(i + 1, { defaults: { task_created: row({ email: true }) } })
      );
      stored = [...unreachable, subscriber()];
      granted = stored.map((u) => String(u._id));

      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(BOARD_FEED_FANOUT_LIMIT + 1)]);
    });

    // BP-735. createNotifications sends no mail at all on an instance without a mail server, so a
    // tick there is no more a subscription than a tick with no address.
    it("a mail tick on an instance with no mail server", async () => {
      mailConfigured = false;
      const unmailable = Array.from({ length: BOARD_FEED_FANOUT_LIMIT }, (_, i) =>
        i % 2
          ? {
              ...member(i + 1, { defaults: { task_created: row({ email: true }) } }),
              email: `m${i}@example.com`,
            }
          : {
              ...member(i + 1, {
                projects: [{ project: PROJECT, matrix: { task_created: row({ email: true }) } }],
              }),
              email: `m${i}@example.com`,
            }
      );
      stored = [...unmailable, subscriber()];
      granted = stored.map((u) => String(u._id));

      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(BOARD_FEED_FANOUT_LIMIT + 1)]);
    });

    it("still counts a mail tick once a mail server is configured", async () => {
      const mailOnly = {
        ...member(1, { defaults: { task_created: row({ email: true }) } }),
        email: "someone@example.com",
      };
      stored = [mailOnly];
      granted = [id(1)];

      mailConfigured = false;
      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([]);
      mailConfigured = true;
      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
    });

    describe("a chat tick whose webhook no configured key can open", () => {
      const KEY = "a".repeat(64);
      const LOST_KEY = "b".repeat(64);
      const saved = { key: process.env.ENCRYPTION_KEY, old: process.env.ENCRYPTION_KEYS_OLD };
      const sealedWith = (key: string) => {
        process.env.ENCRYPTION_KEY = key;
        return encryptSecret("https://hooks.slack.com/services/T0/B0/x");
      };
      const chatOnly = (n: number, webhookUrl: string) =>
        member(n, {
          defaults: { task_created: row({ chat: true }) },
          chat: { kind: "slack", webhookUrl },
        });

      afterEach(() => {
        for (const [name, value] of [
          ["ENCRYPTION_KEY", saved.key],
          ["ENCRYPTION_KEYS_OLD", saved.old],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      });

      // sendPersonalChat skips a webhook it cannot decrypt, so a key rotation that dropped the old
      // key leaves every tick sealed with it delivering nothing
      it("does not spend the cap", async () => {
        const sealed = sealedWith(LOST_KEY);
        process.env.ENCRYPTION_KEY = KEY;
        delete process.env.ENCRYPTION_KEYS_OLD;
        stored = [
          ...Array.from({ length: BOARD_FEED_FANOUT_LIMIT }, (_, i) => chatOnly(i + 1, sealed)),
          subscriber(),
        ];
        granted = stored.map((u) => String(u._id));

        expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(BOARD_FEED_FANOUT_LIMIT + 1)]);
      });

      it("nor with no key configured at all", async () => {
        const sealed = sealedWith(LOST_KEY);
        delete process.env.ENCRYPTION_KEY;
        delete process.env.ENCRYPTION_KEYS_OLD;
        stored = [chatOnly(1, sealed)];
        granted = [id(1)];

        expect(await boardFeedSubscribers(db, PROJECT)).toEqual([]);
      });

      it("counts one sealed with the current key, or with a retired one still configured", async () => {
        const current = sealedWith(KEY);
        const retired = sealedWith(LOST_KEY);
        process.env.ENCRYPTION_KEY = KEY;
        process.env.ENCRYPTION_KEYS_OLD = LOST_KEY;
        stored = [chatOnly(1, current), chatOnly(2, retired)];
        granted = [id(1), id(2)];

        expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1), id(2)]);
      });
    });

    it("still counts a mail tick from somebody with an address", async () => {
      stored = [
        {
          ...member(1, { defaults: { task_created: row({ email: true }) } }),
          email: "someone@example.com",
        },
      ];
      granted = [id(1)];

      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
    });

    // overrideFor reads an entry without a matrix as no override, so the global grid is in force
    it("an entry for this board with no matrix leaves the global tick in force", async () => {
      stored = [
        member(1, {
          defaults: { task_created: row({ inApp: true }) },
          projects: [{ project: PROJECT, matrix: undefined as unknown as Record<string, unknown> }],
        }),
      ];
      granted = [id(1)];

      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
    });

    it("the person who created the task", async () => {
      stored = crowd(BOARD_FEED_FANOUT_LIMIT + 1);
      granted = stored.map((u) => String(u._id));

      const told = await boardFeedSubscribers(db, PROJECT, id(1));

      expect(told).toHaveLength(BOARD_FEED_FANOUT_LIMIT);
      expect(told).not.toContain(id(1));
      expect(told).toContain(id(BOARD_FEED_FANOUT_LIMIT + 1));
    });

    it("still counts a connected chat tick, on this board, as a subscription", async () => {
      stored = [
        member(1, {
          projects: [{ project: PROJECT, matrix: { task_created: row({ chat: true }) } }],
          chat: { kind: "discord", webhookUrl: "enc:abc" },
        }),
      ];
      granted = [id(1)];

      expect(await boardFeedSubscribers(db, PROJECT)).toEqual([id(1)]);
    });
  });

  // Exactly at the cap nobody was left out, and a log line saying otherwise sends an operator
  // looking for people who were never missing.
  it("stays quiet with exactly BOARD_FEED_FANOUT_LIMIT subscribers", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    stored = crowd(BOARD_FEED_FANOUT_LIMIT);
    granted = stored.map((u) => String(u._id));

    expect(await boardFeedSubscribers(db, PROJECT)).toHaveLength(BOARD_FEED_FANOUT_LIMIT);
    expect(reported).not.toHaveBeenCalled();
    reported.mockRestore();
  });

  it("stays quiet when everybody fitted", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    stored = crowd(3);
    granted = stored.map((u) => String(u._id));

    await boardFeedSubscribers(db, PROJECT);

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

    await notifyBoardFeed(db, params);

    expect(createNotifications).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ type: "task_created", recipientIds: [id(1)] })
    );
  });

  it("hands the digest's phrasing on with the title", async () => {
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    await notifyBoardFeed(db, { ...params, digestTitle: "New task in Board Planner" });

    expect(createNotifications).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        title: "New task BP-7 in Board Planner",
        digestTitle: "New task in Board Planner",
      })
    );
  });

  it("writes nothing when nobody subscribed", async () => {
    stored = [member(1)];
    granted = [id(1)];

    await notifyBoardFeed(db, params);

    expect(createNotifications).not.toHaveBeenCalled();
  });

  // Assembling the mail costs a query for the actor's name. Every task created anywhere on the
  // instance would pay it if it were built by the caller — including the great majority nobody
  // has subscribed to.
  it("does not assemble the mail for a board nobody subscribed to", async () => {
    const email = vi.fn().mockResolvedValue({ kicker: "New on the board", taskKey: "BP-7", taskTitle: "x" });
    stored = [member(1)];
    granted = [id(1)];

    await notifyBoardFeed(db, { ...params, email });

    expect(email).not.toHaveBeenCalled();
  });

  it("says nothing to somebody about a task they created themselves", async () => {
    const email = vi.fn().mockResolvedValue({ kicker: "x", taskKey: "BP-7", taskTitle: "x" });
    stored = [member(1, { defaults: { task_created: row({ inApp: true }) } })];
    granted = [id(1)];

    await notifyBoardFeed(db, { ...params, actorId: id(1), email });

    expect(createNotifications).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
  });

  it("assembles it once, and hands it on, when somebody did", async () => {
    const built = { kicker: "New on the board", taskKey: "BP-7", taskTitle: "Bound the fan-out" };
    const email = vi.fn().mockResolvedValue(built);
    stored = [
      {
        ...member(1, { defaults: { task_created: row({ email: true }) } }),
        email: "someone@example.com",
      },
    ];
    granted = [id(1)];

    await notifyBoardFeed(db, { ...params, email });

    expect(email).toHaveBeenCalledTimes(1);
    expect(createNotifications).toHaveBeenCalledWith(db, expect.objectContaining({ email: built }));
  });

  // Nothing awaits this: task creation has already answered the request. A rejection escaping
  // here is an unhandled rejection, which ends the process rather than losing one notification.
  it("does not reject when the subscriber lookup fails", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    userFind.mockImplementationOnce(() => {
      throw new Error("mongo is having a bad afternoon");
    });

    await expect(notifyBoardFeed(db, params)).resolves.toBeUndefined();
    reported.mockRestore();
  });
});
