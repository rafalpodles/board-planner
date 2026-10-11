import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-02T10:00:00Z");
const ENDS = new Date(NOW + 5 * DAY);
const ORGANISATION = new Types.ObjectId();

const getOrganisation = vi.fn();
const settingsFindOne = vi.fn();
const settingsUpdateOne = vi.fn();
const adminAddresses = vi.fn();
const sendEmail = vi.fn();
const isEmailConfigured = vi.fn();
let served: { name: string }[] = [];

const db = { organisation: ORGANISATION, Settings: { findOne: () => ({ lean: async () => settingsFindOne() }), updateOne: (...a: unknown[]) => settingsUpdateOne(...a) } };
vi.mock("@/lib/organisation-jobs", () => ({
  forEachServedOrganisation: async (_job: string, work: (db: unknown) => Promise<void>) => {
    // As the real one: an organisation that fails is logged and the next one goes on
    for (const _ of served) await work(db).catch(() => {});
  },
}));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("@/lib/dead-organisations", () => ({ adminAddresses }));
vi.mock("@/lib/email", () => ({ sendEmail, isEmailConfigured }));
vi.mock("@/lib/organisation-host", () => ({ organisationDomain: () => "board.example", organisationOrigin: async () => "https://acme.board.example" }));

const { noticeEndingTrials } = await import("./sso-trial-notice");

const trial = (over: Record<string, unknown> = {}) => ({ name: "Acme", entitlements: { plan: "pro", trial: true, expiresAt: ENDS, ...over } });

beforeEach(() => {
  vi.clearAllMocks();
  served = [{ name: "Acme" }];
  isEmailConfigured.mockReturnValue(true);
  getOrganisation.mockResolvedValue(trial());
  adminAddresses.mockResolvedValue(["boss@acme.test", "deputy@acme.test"]);
  sendEmail.mockResolvedValue(true);
  settingsFindOne.mockReturnValue({ sso: { issuer: "https://login.acme.example" } });
  settingsUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});
afterEach(() => vi.restoreAllMocks());

describe("telling an ending trial that its single sign-on stops with it (BP-951)", () => {
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
    expect(settingsUpdateOne).toHaveBeenCalledWith({ ssoTrialNoticeFor: { $ne: ENDS } }, { $set: { ssoTrialNoticeFor: ENDS } });
  });

  it("says nothing to a trial that ends later than a week from now, or that ended, or an organisation that is not on one", async () => {
    getOrganisation.mockResolvedValueOnce(trial({ expiresAt: new Date(NOW + 8 * DAY) }));
    getOrganisation.mockResolvedValueOnce(trial({ expiresAt: new Date(NOW - 1000) }));
    getOrganisation.mockResolvedValueOnce(trial({ trial: false }));
    served = [{ name: "a" }, { name: "b" }, { name: "c" }];

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 3, noticed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("says nothing to an organisation that did not set up a provider", async () => {
    settingsFindOne.mockReturnValue({});

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(settingsUpdateOne).not.toHaveBeenCalled();
  });

  it("says nothing twice for one trial", async () => {
    settingsFindOne.mockReturnValue({ sso: {}, ssoTrialNoticeFor: ENDS });

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("leaves it to the process that claimed it first", async () => {
    settingsUpdateOne.mockResolvedValue({ modifiedCount: 0 });

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("lets go of the claim when nobody could be reached, so the next pass tries again", async () => {
    sendEmail.mockResolvedValue(false);

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(settingsUpdateOne).toHaveBeenLastCalledWith({ ssoTrialNoticeFor: ENDS }, { $set: { ssoTrialNoticeFor: null } });
  });

  it("lets go of the claim when the sending itself fails, so the next pass tries again", async () => {
    adminAddresses.mockRejectedValue(new Error("mongo went away"));

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 1, noticed: 0 });
    expect(settingsUpdateOne).toHaveBeenLastCalledWith({ ssoTrialNoticeFor: ENDS }, { $set: { ssoTrialNoticeFor: null } });
  });

  it("does nothing without a mail server", async () => {
    isEmailConfigured.mockReturnValue(false);

    expect(await noticeEndingTrials(NOW)).toEqual({ looked: 0, noticed: 0 });
    expect(getOrganisation).not.toHaveBeenCalled();
  });
});
