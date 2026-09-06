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
  it("keeps the bell on every row it used to ring, and follows emailNotifications for mail", () => {
    const m = defaultMatrix({ emailNotifications: true });

    for (const type of NOTIFICATION_TYPES.filter((t) => t !== "task_created")) {
      expect(m[type]).toEqual({ inApp: true, email: true, chat: false });
    }
  });

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

  it("seeds a new override from the values in force", () => {
    expect(matrixInForce(user, P1).mentioned).toEqual({ inApp: true, email: true, chat: false });
    expect(matrixInForce(user, P2).mentioned).toEqual({ inApp: false, email: false, chat: false });
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
