import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-02T10:00:00Z");

const find = vi.fn();
const updateOne = vi.fn();
const settingsFindOne = vi.fn();
const adminAddresses = vi.fn();
const sendEmail = vi.fn();
const isEmailConfigured = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/organisation", () => ({
  Organisation: { find: (...a: unknown[]) => ({ select: () => ({ lean: async () => find(...a) }) }), updateOne: (...a: unknown[]) => updateOne(...a) },
}));
vi.mock("@/lib/db-scope", () => ({ scoped: () => ({ Settings: { findOne: () => ({ lean: async () => settingsFindOne() }) } }) }));
vi.mock("@/lib/dead-organisations", () => ({ adminAddresses }));
vi.mock("@/lib/email", () => ({ sendEmail, isEmailConfigured }));
vi.mock("@/lib/organisation-host", () => ({
  organisationDomain: () => "board.example",
  organisationOrigin: async () => "https://acme.board.example",
}));

const { noticeEndingTrials } = await import("./sso-trial-notice");

const ENDS = new Date(NOW + 5 * DAY);
const row = (over: Record<string, unknown> = {}) => ({ _id: new Types.ObjectId(), name: "Acme", entitlements: { plan: "pro", trial: true, expiresAt: ENDS }, ssoTrialNoticeFor: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  isEmailConfigured.mockReturnValue(true);
  adminAddresses.mockResolvedValue(["boss@acme.test", "deputy@acme.test"]);
  sendEmail.mockResolvedValue(true);
  settingsFindOne.mockReturnValue({ sso: { issuer: "https://login.acme.example" } });
  updateOne.mockResolvedValue({ modifiedCount: 1 });
  find.mockResolvedValue([row()]);
});
afterEach(() => vi.restoreAllMocks());

describe("telling an ending trial that its single sign-on stops with it (BP-951)", () => {
  it("asks only for trials that end within the week, in organisations nobody has suspended or deleted", async () => {
    await noticeEndingTrials(NOW);

    const filter = find.mock.calls[0][0];
    expect(filter).toMatchObject({ deletedAt: null, suspendedAt: null, "entitlements.trial": true });
    expect(filter["entitlements.expiresAt"]).toEqual({ $gt: new Date(NOW), $lte: new Date(NOW + 7 * DAY) });
  });

  it("e-mails every administrator once, saying when it stops and that what they entered is kept", async () => {
    const done = await noticeEndingTrials(NOW);

    expect(done).toEqual({ looked: 1, noticed: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("boss@acme.test");
    expect(mail.subject).toContain("7 November 2026");
    expect(mail.text).toContain("stays saved and comes back with Pro");
    expect(mail.text).toContain("Forgot password");
    expect(mail.text).toContain("https://acme.board.example/settings/organisation");
    expect(updateOne).toHaveBeenCalledWith({ _id: expect.anything(), ssoTrialNoticeFor: { $ne: ENDS } }, { $set: { ssoTrialNoticeFor: ENDS } });
  });

  it("says nothing to an organisation that did not set up a provider", async () => {
    settingsFindOne.mockReturnValue({});

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("says nothing twice for one trial", async () => {
    find.mockResolvedValue([row({ ssoTrialNoticeFor: ENDS })]);

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("leaves it to the process that claimed it first", async () => {
    updateOne.mockResolvedValue({ modifiedCount: 0 });

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("lets go of the claim when nobody could be reached, so the next pass tries again", async () => {
    sendEmail.mockResolvedValue(false);

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(updateOne).toHaveBeenLastCalledWith({ _id: expect.anything(), ssoTrialNoticeFor: ENDS }, { $set: { ssoTrialNoticeFor: null } });
  });

  it("does nothing without a mail server", async () => {
    isEmailConfigured.mockReturnValue(false);

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 0, noticed: 0 });
    expect(find).not.toHaveBeenCalled();
  });

  it("goes on to the next organisation when one fails", async () => {
    const second = row();
    find.mockResolvedValue([row(), second]);
    settingsFindOne.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 2, noticed: 1 });
    expect(error).toHaveBeenCalled();
  });
});
