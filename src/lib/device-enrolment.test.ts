import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const findOne = vi.fn();
const find = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();
const projectLean = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/deviceEnrolment", () => ({
  DeviceEnrolment: { create, findOne, find, findOneAndUpdate, updateOne },
}));
// The poll now also reads the approved project, so the app knows what to clone
vi.mock("@/models/project", () => ({
  Project: { findById: () => ({ select: () => ({ lean: projectLean }) }) },
}));

const {
  startDeviceEnrolment,
  pollDeviceEnrolment,
  denyDeviceEnrolment,
  formatUserCode,
  normaliseUserCode,
  PRESET_POLICY,
  isWorkerPreset,
} = await import("./device-enrolment");

const bcrypt = (await import("bcryptjs")).default;

function candidates(rows: unknown[]) {
  find.mockReturnValue({ sort: () => ({ limit: () => Promise.resolve(rows) }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
  candidates([]);
  projectLean.mockResolvedValue({ key: "TP", repositoryUrl: "https://github.com/o/r" });
});

describe("starting an enrolment", () => {
  it("mints a device code the app keeps and a short code a person reads", async () => {
    const started = await startDeviceEnrolment({ machineName: "MacBook", machineHost: "mac.local" });

    expect(started.deviceCode).toMatch(/^cpd_[0-9a-f]{64}$/);
    expect(started.userCode).toMatch(/^[BCDFGHJKMNPQRSTVWXZ23456789]{8}$/);
  });

  // The device code is the app's half of the exchange and is what the credential is handed to
  it("stores only a hash of the device code", async () => {
    const started = await startDeviceEnrolment({ machineName: "MacBook", machineHost: "" });
    const stored = create.mock.calls[0][0];

    expect(stored.deviceCodeHash).not.toBe(started.deviceCode);
    expect(await bcrypt.compare(started.deviceCode, stored.deviceCodeHash)).toBe(true);
  });

  it("starts pending, so nothing is granted before a person approves", async () => {
    await startDeviceEnrolment({ machineName: "MacBook", machineHost: "" });

    expect(create.mock.calls[0][0].status).toBe("pending");
  });

  it("expires within the quarter hour, so an abandoned attempt reaps itself", async () => {
    const now = new Date("2026-08-05T10:00:00.000Z");

    const started = await startDeviceEnrolment({ machineName: "M", machineHost: "" }, now);

    expect(started.expiresAt.getTime() - now.getTime()).toBe(15 * 60 * 1000);
  });

  // The user code is short by design, so a collision has to be retried rather than assumed away —
  // handing a second machine someone else's approval is the failure that matters here
  it("retries on a duplicate user code instead of failing the machine", async () => {
    create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: 11000 }));
    create.mockResolvedValueOnce({});

    await expect(startDeviceEnrolment({ machineName: "M", machineHost: "" })).resolves.toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("uses no character anyone has to squint at", async () => {
    const started = await startDeviceEnrolment({ machineName: "M", machineHost: "" });

    expect(started.userCode).not.toMatch(/[O0I1LUAEY]/);
  });
});

describe("polling for the credential", () => {
  async function row(overrides: Record<string, unknown> = {}) {
    const deviceCode = `cpd_${"a".repeat(64)}`;
    return {
      deviceCode,
      doc: {
        _id: "e1",
        deviceCodeHash: await bcrypt.hash(deviceCode, 10),
        status: "approved",
        credential: "cpw_secret",
        worker: "w1",
        project: "p1",
        expiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      },
    };
  }

  it("says pending while nobody has approved it", async () => {
    const { deviceCode, doc } = await row({ status: "pending", credential: "" });
    candidates([doc]);

    expect(await pollDeviceEnrolment(deviceCode)).toEqual({ state: "pending" });
  });

  it("hands back the credential once approved", async () => {
    const { deviceCode, doc } = await row();
    candidates([doc]);
    findOneAndUpdate.mockResolvedValue({ credential: "cpw_secret", worker: "w1", project: "p1" });

    expect(await pollDeviceEnrolment(deviceCode)).toEqual({
      state: "approved",
      workerId: "w1",
      credential: "cpw_secret",
      // What the app clones, and where it puts it — <folder>/<projectKey>
      repositoryUrl: "https://github.com/o/r",
      projectKey: "TP",
    });
  });

  // Single use. The credential is cleared in the same conditional update that returns it, so two
  // polls racing cannot both come away holding it.
  it("claims the credential with a conditional update, not a read then a write", async () => {
    const { deviceCode, doc } = await row();
    candidates([doc]);
    findOneAndUpdate.mockResolvedValue({ credential: "cpw_secret", worker: "w1", project: "p1" });

    await pollDeviceEnrolment(deviceCode);

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter.credential).toEqual({ $ne: "" });
    expect(update.$set.credential).toBe("");
  });

  it("gives nothing to a second poll once the credential is collected", async () => {
    const { deviceCode, doc } = await row();
    candidates([doc]);
    findOneAndUpdate.mockResolvedValue(null);

    expect(await pollDeviceEnrolment(deviceCode)).toEqual({ state: "expired" });
  });

  it("refuses an expired approval rather than handing over a stale credential", async () => {
    const { deviceCode, doc } = await row({ expiresAt: new Date(Date.now() - 1) });
    candidates([doc]);

    expect(await pollDeviceEnrolment(deviceCode)).toEqual({ state: "expired" });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  // A code that was never issued must look exactly like one that has been spent
  it("answers the same for a device code nobody ever issued", async () => {
    candidates([]);

    expect(await pollDeviceEnrolment(`cpd_${"b".repeat(64)}`)).toEqual({ state: "expired" });
  });

  it("does not go near the database for a string that is not a device code", async () => {
    expect(await pollDeviceEnrolment("not-a-code")).toEqual({ state: "expired" });
    expect(find).not.toHaveBeenCalled();
  });
});

describe("refusing an enrolment", () => {
  it("only ever moves a pending row, so an approval cannot be undone into a denial", async () => {
    updateOne.mockResolvedValue({ modifiedCount: 1 });

    await denyDeviceEnrolment("BCDF-2345");

    expect(updateOne.mock.calls[0][0].status).toBe("pending");
    expect(updateOne.mock.calls[0][1].$set.credential).toBe("");
  });
});

describe("the presets", () => {
  // Merging without review is the pair the validator refuses. Offering presets rather than gates
  // means it is unreachable here by construction, not merely rejected later.
  it("cannot express merging without review", () => {
    for (const policy of Object.values(PRESET_POLICY)) {
      expect(policy.autoMerge && !policy.reviewGate).toBe(false);
    }
  });

  it("maps each preset to the two booleans it means", () => {
    expect(PRESET_POLICY.write).toEqual({ reviewGate: false, autoMerge: false });
    expect(PRESET_POLICY.review).toEqual({ reviewGate: true, autoMerge: false });
    expect(PRESET_POLICY.merge).toEqual({ reviewGate: true, autoMerge: true });
  });

  it("refuses anything that is not one of the three", () => {
    expect(isWorkerPreset("write")).toBe(true);
    expect(isWorkerPreset("merge-without-review")).toBe(false);
    expect(isWorkerPreset(undefined)).toBe(false);
  });
});

describe("reading the code off a screen", () => {
  it("groups it so it can be read aloud", () => {
    expect(formatUserCode("BCDF2345")).toBe("BCDF-2345");
  });

  it("takes it back however it was typed", () => {
    expect(normaliseUserCode("bcdf-2345")).toBe("BCDF2345");
    expect(normaliseUserCode(" bcdf 2345 ")).toBe("BCDF2345");
    expect(normaliseUserCode(null)).toBe("");
  });
});
