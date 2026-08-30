import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const findOne = vi.fn();
const find = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();
const projectLean = vi.fn();
const countDocuments = vi.fn();
const deleteMany = vi.fn();
const sort = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/deviceEnrolment", () => ({
  DeviceEnrolment: { create, findOne, find, findOneAndUpdate, updateOne, countDocuments, deleteMany },
}));
// The poll now also reads the approved project, so the app knows what to clone
vi.mock("@/models/project", () => ({
  Project: { findById: () => ({ select: () => ({ lean: projectLean }) }) },
}));

const {
  MAX_PENDING_ENROLMENTS,
  startDeviceEnrolment,
  pollDeviceEnrolment,
  denyDeviceEnrolment,
  formatUserCode,
  normaliseUserCode,
} = await import("./device-enrolment");

const bcrypt = (await import("bcryptjs")).default;

function candidates(rows: unknown[]) {
  find.mockReturnValue({ limit: () => Promise.resolve(rows) });
}

// The eviction query: find(live).sort(...).limit(n).select("_id").lean()
function oldestPending(rows: unknown[]) {
  sort.mockReturnValue({
    limit: () => ({ select: () => ({ lean: () => Promise.resolve(rows) }) }),
  });
  find.mockReturnValue({ sort });
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
  countDocuments.mockResolvedValue(0);
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

// BP-305: the poll used to load 200 rows and bcrypt.compare each one — 85ms apiece, ~17s of CPU
// per unauthenticated request, with the attacker supplying the rows through the equally
// unauthenticated start endpoint
describe("the cost of a poll", () => {
  it("narrows candidates by the indexed prefix instead of a 200-row window", async () => {
    await pollDeviceEnrolment("cpd_" + "a".repeat(64));

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ deviceCodePrefix: "cpd_aaaaaaaa" })
    );
    expect(find.mock.results[0].value.sort).toBeUndefined();
  });

  it("stores the prefix so the narrowed lookup can find the row", async () => {
    const started = await startDeviceEnrolment({ machineName: "MacBook", machineHost: "" });

    expect(create.mock.calls[0][0].deviceCodePrefix).toBe(started.deviceCode.slice(0, 12));
  });

  // BP-322: the ceiling counted everybody's rows and refused the caller who hit it, so twenty
  // anonymous posts closed enrolment for every genuine operator until they reaped.
  it("does not refuse an operator because the window is full", async () => {
    countDocuments.mockResolvedValue(MAX_PENDING_ENROLMENTS);
    oldestPending([{ _id: "oldest" }]);

    const started = await startDeviceEnrolment({ machineName: "MacBook", machineHost: "" });

    expect(started.userCode).toBeTruthy();
    expect(create).toHaveBeenCalled();
  });

  it("makes room by dropping the oldest pending row", async () => {
    countDocuments.mockResolvedValue(MAX_PENDING_ENROLMENTS + 2);
    oldestPending([{ _id: "a" }, { _id: "b" }, { _id: "c" }]);

    await startDeviceEnrolment({ machineName: "MacBook", machineHost: "" });

    // Ascending, so it is the oldest that goes. Descending would evict the row the operator is
    // holding at that moment and leave the flood's own rows in place.
    expect(sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(find.mock.calls[0][0]).toMatchObject({ status: "pending" });
    expect(deleteMany).toHaveBeenCalledWith({ _id: { $in: ["a", "b", "c"] } });
  });

  it("touches nothing while the window has room — the control", async () => {
    countDocuments.mockResolvedValue(3);

    await startDeviceEnrolment({ machineName: "MacBook", machineHost: "" });

    expect(deleteMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
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
