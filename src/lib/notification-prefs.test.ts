import { describe, it, expect } from "vitest";
import {
  defaultMatrix,
  resolveChannels,
  matrixInForce,
  normaliseMatrix,
  hasOverride,
  wantsMailSomewhere,
  wantsChat,
} from "@/lib/notification-prefs";
import { NOTIFICATION_TYPES, NotificationMatrix } from "@/types";

const P1 = "507f1f77bcf86cd799439011";
const P2 = "507f1f77bcf86cd799439012";

const allOff = (): NotificationMatrix =>
  Object.fromEntries(
    NOTIFICATION_TYPES.map((t) => [t, { inApp: false, email: false, chat: false }])
  ) as NotificationMatrix;

describe("an account that predates the grid", () => {
  // The whole migration story: no document is rewritten, so the old booleans have to keep
  // producing exactly today's behaviour
  it("keeps the bell on every row it used to ring, and follows emailNotifications for mail", () => {
    const m = defaultMatrix({ emailNotifications: true });

    for (const type of NOTIFICATION_TYPES.filter((t) => t !== "task_created")) {
      expect(m[type]).toEqual({ inApp: true, email: true, chat: false });
    }
  });

  // The row is new, so there is no behaviour to preserve — and the legacy default is the one
  // place a new row could subscribe every existing account to a firehose by being added. Adding
  // task_created to legacyMatrix alongside the rest is exactly the edit that would do it.
  it("is not subscribed to every task on every board it can reach", () => {
    const m = defaultMatrix({ emailNotifications: true });

    expect(m.task_created).toEqual({ inApp: false, email: false, chat: false });
  });

  it("still rings the bell when mail was switched off", () => {
    const m = defaultMatrix({ emailNotifications: false });

    expect(m.mentioned).toEqual({ inApp: true, email: false, chat: false });
  });

  it("treats a missing user as mail off rather than throwing", () => {
    expect(defaultMatrix(null).mentioned.email).toBe(false);
    expect(defaultMatrix(null).mentioned.inApp).toBe(true);
  });
});

describe("resolving one event for one project", () => {
  const user = {
    emailNotifications: true,
    notifications: {
      defaults: { ...allOff(), mentioned: { inApp: true, email: true, chat: true } },
      projects: [{ project: P2, matrix: { ...allOff(), mentioned: { inApp: true, email: false, chat: false } } }],
      chat: { kind: "slack" as const, webhookUrl: "x" },
    },
  };

  it("uses the global row for a project with no override", () => {
    expect(resolveChannels(user, P1, "mentioned")).toEqual({ inApp: true, email: true, chat: true });
  });

  it("uses the project's own row where there is one", () => {
    expect(resolveChannels(user, P2, "mentioned")).toEqual({ inApp: true, email: false, chat: false });
  });

  // Stored defaults win over the legacy boolean, or saving the grid would appear to do nothing
  it("ignores emailNotifications once defaults are stored", () => {
    expect(resolveChannels(user, P1, "comment_added").email).toBe(false);
  });

  it("survives a project id it has never seen", () => {
    expect(resolveChannels(user, "507f1f77bcf86cd799439099", "mentioned").email).toBe(true);
  });
});

describe("what the project screen shows", () => {
  const user = {
    emailNotifications: false,
    notifications: {
      defaults: { ...allOff(), mentioned: { inApp: true, email: true, chat: false } },
      projects: [{ project: P2, matrix: allOff() }],
      chat: { kind: "" as const, webhookUrl: "" },
    },
  };

  it("reports whether this project overrides anything", () => {
    expect(hasOverride(user, P2)).toBe(true);
    expect(hasOverride(user, P1)).toBe(false);
  });

  // Turning the switch on copies what is in force now, so a later change to the global grid does
  // not reach into a project somebody has already tuned
  it("seeds a new override from the values in force", () => {
    expect(matrixInForce(user, P1).mentioned).toEqual({ inApp: true, email: true, chat: false });
    expect(matrixInForce(user, P2).mentioned).toEqual({ inApp: false, email: false, chat: false });
  });
});

/**
 * A row can be added to the grid long after somebody last saved theirs. Blank would record it as
 * a "no" they never gave, and would split the population in two: accounts that never opened the
 * screen would hear about it (the legacy fallback) while accounts that had been there would not.
 */
describe("a row nobody has been asked about", () => {
  it("takes the same default a grid that was never saved takes", () => {
    const stored = allOff();
    delete (stored as Partial<NotificationMatrix>).task_linked;
    stored.status_changed = { inApp: false, email: false, chat: false };

    const m = defaultMatrix({ notifications: { defaults: stored } });

    expect(m.task_linked).toEqual({ inApp: true, email: false, chat: false });
    // and the rows they DID answer are left exactly as answered
    expect(m.status_changed).toEqual({ inApp: false, email: false, chat: false });
  });

  // The firehose row is the exception everywhere, including here
  it("leaves the board-wide row off", () => {
    const stored = allOff();
    delete (stored as Partial<NotificationMatrix>).task_created;

    expect(defaultMatrix({ notifications: { defaults: stored } }).task_created).toEqual({
      inApp: false,
      email: false,
      chat: false,
    });
  });

  // Mail is the one channel they HAVE answered for every row they saw; a new row is not consent
  it("does not start writing to their inbox on the strength of an old boolean", () => {
    const stored = allOff();
    delete (stored as Partial<NotificationMatrix>).task_linked;

    const m = defaultMatrix({ emailNotifications: true, notifications: { defaults: stored } });

    expect(m.task_linked.email).toBe(false);
  });

  // The control: an account with no grid at all still follows the old boolean
  it("still follows the old boolean for an account that never saved anything", () => {
    expect(defaultMatrix({ emailNotifications: true }).task_linked).toEqual({
      inApp: true,
      email: true,
      chat: false,
    });
  });

  // A project override is a grid somebody saved just as much as the global one is, and it is the
  // half a first pass at this missed: fixing only defaultMatrix left the new row silent on every
  // board anybody had ever ticked "use my own settings" for.
  it("fills the row in a project's own grid too", () => {
    const own = allOff();
    delete (own as Partial<NotificationMatrix>).task_linked;
    own.comment_added = { inApp: true, email: false, chat: false };
    const user = { notifications: { projects: [{ project: P1, matrix: own }] } };

    expect(matrixInForce(user, P1).task_linked).toEqual({
      inApp: true,
      email: false,
      chat: false,
    });
    // and the rows that grid did answer are still its own, not the global grid's
    expect(matrixInForce(user, P1).comment_added).toEqual({
      inApp: true,
      email: false,
      chat: false,
    });
    expect(resolveChannels(user, P1, "task_linked").inApp).toBe(true);
  });

  // The control: an override that answers the row keeps its answer, including a deliberate no
  it("leaves a row the project's grid did answer exactly as answered", () => {
    const own = allOff();
    own.task_linked = { inApp: false, email: false, chat: false };
    const user = { notifications: { projects: [{ project: P1, matrix: own }] } };

    expect(resolveChannels(user, P1, "task_linked").inApp).toBe(false);
  });
});

describe("normalising what a client sends", () => {
  it("fills in every row and drops anything it does not recognise", () => {
    const m = normaliseMatrix({ mentioned: { inApp: true }, nonsense: { inApp: true } });

    expect(Object.keys(m).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    expect(m.mentioned).toEqual({ inApp: true, email: false, chat: false });
    expect(m.comment_added).toEqual({ inApp: false, email: false, chat: false });
  });

  it("coerces junk to false rather than storing it", () => {
    const m = normaliseMatrix({ mentioned: { inApp: "yes", email: 1, chat: null } });

    expect(m.mentioned).toEqual({ inApp: false, email: false, chat: false });
  });

  it("returns an all-off grid for a body that is not an object", () => {
    expect(normaliseMatrix(null).mentioned).toEqual({ inApp: false, email: false, chat: false });
  });
});

// The digest asks this before it builds anything. Asking only the global grid dropped anyone who
// had switched mail off globally and on for one project — and since the immediate mail is already
// suppressed for a digest subscriber, they got nothing at all.
describe("whether any grid asks for mail", () => {
  it("counts a project override that turns mail on, with the global grid silent", () => {
    const user = {
      emailNotifications: false,
      notifications: {
        defaults: allOff(),
        projects: [
          { project: P1, matrix: { ...allOff(), comment_added: { inApp: true, email: true, chat: false } } },
        ],
      },
    };

    expect(wantsMailSomewhere(user)).toBe(true);
  });

  it("is false when nothing anywhere asks for mail", () => {
    expect(
      wantsMailSomewhere({ emailNotifications: false, notifications: { defaults: allOff(), projects: [] } })
    ).toBe(false);
  });

  it("still follows the legacy boolean for an account with no grid", () => {
    expect(wantsMailSomewhere({ emailNotifications: true })).toBe(true);
    expect(wantsMailSomewhere({ emailNotifications: false })).toBe(false);
  });
});

/**
 * Whether chat can deliver is derived here rather than written into the grids. Storing it meant
 * disconnecting had to rewrite the global grid and every project override, and each attempt cost
 * something — a wholesale $set regenerated subdocument ids, a row-by-row one wrote by an index a
 * concurrent request could shift, and the screen disabled the checkbox that would have undone it.
 */
describe("chat delivery follows the connection, not the stored tick", () => {
  const ticked = {
    notifications: {
      defaults: { ...allOff(), mentioned: { inApp: true, email: false, chat: true } },
      projects: [],
    },
  };

  it("does not deliver to chat when nothing is connected", () => {
    expect(resolveChannels(ticked, P1, "mentioned").chat).toBe(false);
  });

  it("does not deliver when a service is named but no address is stored", () => {
    const half = { ...ticked, notifications: { ...ticked.notifications, chat: { kind: "slack" as const, webhookUrl: "" } } };

    expect(resolveChannels(half, P1, "mentioned").chat).toBe(false);
  });

  it("delivers once both halves are there, with the same stored tick", () => {
    const whole = {
      ...ticked,
      notifications: {
        ...ticked.notifications,
        chat: { kind: "slack" as const, webhookUrl: "enc:x" },
      },
    };

    expect(resolveChannels(whole, P1, "mentioned").chat).toBe(true);
  });

  // The tick itself is never rewritten — the reader's choice survives a connection coming and going
  it("leaves the other channels of the row alone", () => {
    expect(resolveChannels(ticked, P1, "mentioned")).toEqual({
      inApp: true,
      email: false,
      chat: false,
    });
  });
});

describe("whether a grid asks for chat", () => {
  it("is true for any row, and false for none", () => {
    expect(wantsChat({ ...allOff(), mentioned: { inApp: false, email: false, chat: true } })).toBe(true);
    expect(wantsChat(allOff())).toBe(false);
  });
});
