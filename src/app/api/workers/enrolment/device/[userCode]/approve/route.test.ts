import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const denyDeviceEnrolment = vi.fn();
const findPendingByUserCode = vi.fn();
const registerWorker = vi.fn();

const projectSelect = vi.fn();
const projectUpdateOne = vi.fn();
const workerUpdateOne = vi.fn();
const deviceEnrolmentUpdateOne = vi.fn();
const agentFindOneLean = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/device-enrolment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/device-enrolment")>();
  return { ...actual, denyDeviceEnrolment, findPendingByUserCode };
});
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, registerWorker };
});
vi.mock("@/models/project", () => ({
  Project: { findById: () => ({ select: projectSelect }), updateOne: projectUpdateOne },
}));
vi.mock("@/models/deviceEnrolment", () => ({
  DeviceEnrolment: { updateOne: deviceEnrolmentUpdateOne },
}));
vi.mock("@/models/worker", () => ({ Worker: { updateOne: workerUpdateOne } }));
vi.mock("@/models/agent", () => ({ Agent: { findOne: () => ({ lean: agentFindOneLean }) } }));

const { POST } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin", fullName: "Rafal Podles", username: "rpo" };
const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";

function enrolment(overrides: Record<string, unknown> = {}) {
  return {
    _id: "enr-1",
    userCode: "ABCD-1234",
    machineName: "rig-laptop",
    machineHost: "mac.home",
    status: "pending",
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROJECT_ID,
    key: "BP",
    githubRepo: "owner/repo",
    worker: { enabled: false },
    ...overrides,
  };
}

function request(body: unknown = {}) {
  return new Request("http://localhost/api/workers/enrolment/device/ABCD-1234/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(userCode = "ABCD-1234") {
  return { params: Promise.resolve({ userCode }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  findPendingByUserCode.mockResolvedValue(enrolment());
  projectSelect.mockResolvedValue(project());
  projectUpdateOne.mockResolvedValue({});
  agentFindOneLean.mockResolvedValue({ _id: "agent-1" });
  registerWorker.mockResolvedValue({
    worker: { _id: "w1", name: "rig-laptop" },
    credential: "cpw_secret",
  });
  workerUpdateOne.mockResolvedValue({});
  deviceEnrolmentUpdateOne.mockResolvedValue({});
  denyDeviceEnrolment.mockResolvedValue(true);
});

// BP-358: this is "the path people actually take" per the route's own comment — one click enables
// a project and registers a machine, and the admin approving it is who that machine belongs to.
// Until now this route had no test file at all.
describe("POST /api/workers/enrolment/device/:userCode/approve", () => {
  it("passes the approving admin as the machine's owner, by name and by id", async () => {
    await POST(request({ projectId: PROJECT_ID, preset: "write" }), ctx());

    expect(registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "rig-laptop",
        host: "mac.home",
        owner: "Rafal Podles",
        ownerId: "admin-1",
      })
    );
  });

  it("falls back to the username when the admin has no display name", async () => {
    getAuthUser.mockResolvedValue({ _id: "admin-2", role: "admin", fullName: "", username: "rpo2" });

    await POST(request({ projectId: PROJECT_ID, preset: "write" }), ctx());

    expect(registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "rpo2", ownerId: "admin-2" })
    );
  });

  it("registers the machine and returns its id", async () => {
    const response = await POST(request({ projectId: PROJECT_ID, preset: "write" }), ctx());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "approved", workerId: "w1" });
  });
});
