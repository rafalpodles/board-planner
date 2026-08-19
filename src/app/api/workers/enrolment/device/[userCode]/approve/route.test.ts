import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const logInstanceAudit = vi.fn();
const denyDeviceEnrolment = vi.fn();
const findPendingByUserCode = vi.fn();
const registerWorker = vi.fn();

const projectSelect = vi.fn();
const projectUpdateOne = vi.fn();
const deviceEnrolmentUpdateOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
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

const { POST } = await import("./route");

const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";
// An ordinary member connecting their own laptop — the case admin approval used to stand in front
// of, and the one the whole of BP-358 is about.
const MEMBER = { _id: "member-1", role: "member", fullName: "Rafal Podles", username: "rpo" };
const ADMIN = { _id: "admin-1", role: "admin", fullName: "Ada", username: "ada" };

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

// Reach is a grant; committing the project to machines is not — that is instance-admin, decided by
// the account's role, exactly as PUT /api/projects/:id has it.
function grants(access: boolean) {
  check.mockResolvedValue(access);
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(MEMBER);
  grants(true);
  findPendingByUserCode.mockResolvedValue(enrolment());
  projectSelect.mockResolvedValue(project());
  projectUpdateOne.mockResolvedValue({});
  registerWorker.mockResolvedValue({
    worker: { _id: "w1", name: "rig-laptop" },
    credential: "cpw_secret",
  });
  deviceEnrolmentUpdateOne.mockResolvedValue({});
  denyDeviceEnrolment.mockResolvedValue(true);
});

// BP-358: this is "the path people actually take" — one click connects a machine, and the person
// confirming is who that machine belongs to. There is no admin approval step in front of it any
// more: a machine runs only its owner's own work, inside permissions that person already holds.
describe("POST /api/workers/enrolment/device/:userCode/approve", () => {
  it("passes the person confirming as the machine's owner, by name and by id", async () => {
    await POST(request({ projectId: PROJECT_ID }), ctx());

    expect(registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "rig-laptop",
        host: "mac.home",
        owner: "Rafal Podles",
        ownerId: "member-1",
      })
    );
  });

  it("falls back to the username when they have no display name", async () => {
    getAuthUser.mockResolvedValue({ ...MEMBER, _id: "member-2", fullName: "", username: "rpo2" });

    await POST(request({ projectId: PROJECT_ID }), ctx());

    expect(registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "rpo2", ownerId: "member-2" })
    );
  });

  // The removed gate: MEMBER has role "member", so an admin-gated route answers 403 here.
  it("registers the machine for an ordinary member and returns its id", async () => {
    const response = await POST(request({ projectId: PROJECT_ID }), ctx());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "approved", workerId: "w1" });
  });

  // The machine is told what to clone, so a project this person cannot reach must not have its
  // repository address handed over. 404 rather than 403: existence is the thing being hidden.
  it("refuses a project the person confirming cannot reach", async () => {
    grants(false);

    const response = await POST(request({ projectId: PROJECT_ID }), ctx());

    expect(response.status).toBe(404);
    expect(registerWorker).not.toHaveBeenCalled();
  });

  describe("committing the project to machines", () => {
    // Still a project-admin decision with its own audit row: a member connecting their laptop does
    // not make it on the project's behalf.
    // A project OWNER, not just any member: owning a project is what would make this look like a
    // project-admin decision, and PUT /api/projects/:id refuses them too
    it("leaves the switch alone for a member, even one who owns the project", async () => {
      const response = await POST(request({ projectId: PROJECT_ID }), ctx());

      expect(projectUpdateOne).not.toHaveBeenCalled();
      expect((await response.json()).workersEnabled).toBe(false);
      expect(logInstanceAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "project_workers_enabled" })
      );
    });

    it("turns it on, and records that, for an instance admin", async () => {
      getAuthUser.mockResolvedValue(ADMIN);

      const response = await POST(request({ projectId: PROJECT_ID }), ctx());

      expect(projectUpdateOne).toHaveBeenCalledWith(
        { _id: PROJECT_ID },
        { $set: { "worker.enabled": true } }
      );
      expect((await response.json()).workersEnabled).toBe(true);
      expect(logInstanceAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "project_workers_enabled", target: "BP" })
      );
    });

    it("records nothing when the switch was already on", async () => {
      getAuthUser.mockResolvedValue(ADMIN);
      projectSelect.mockResolvedValue(project({ worker: { enabled: true } }));

      await POST(request({ projectId: PROJECT_ID }), ctx());

      expect(projectUpdateOne).not.toHaveBeenCalled();
      expect(logInstanceAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "project_workers_enabled" })
      );
    });

    // A member connecting to an already-enabled project still gets a machine that will run
    it("reports the switch as on when somebody else already turned it on", async () => {
      projectSelect.mockResolvedValue(project({ worker: { enabled: true } }));

      const response = await POST(request({ projectId: PROJECT_ID }), ctx());

      expect((await response.json()).workersEnabled).toBe(true);
    });
  });

  // The preset used to write project.worker.agent — the project's default. After BP-358 that field
  // only decides which agent the task picker offers first, so an enrolling person would have been
  // silently changing a project-wide suggestion for everyone from a screen about their own laptop.
  it("does not write a project-wide agent from the enrolment", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await POST(request({ projectId: PROJECT_ID, preset: "merge" }), ctx());

    expect(projectUpdateOne).toHaveBeenCalledTimes(1);
    expect(projectUpdateOne.mock.calls[0][1]).toEqual({ $set: { "worker.enabled": true } });
  });

  it("records who the machine belongs to on the enrolment row", async () => {
    await POST(request({ projectId: PROJECT_ID }), ctx());

    expect(deviceEnrolmentUpdateOne.mock.calls[0][1].$set).toMatchObject({
      status: "approved",
      enrolledBy: "member-1",
      worker: "w1",
    });
  });

  // Still not something a machine can do for itself: a credential readable off the worker's disk
  // must not be able to enrol a second one.
  it("refuses a machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...MEMBER, viaMachineCredential: true });

    const response = await POST(request({ projectId: PROJECT_ID }), ctx());

    expect(response.status).toBe(403);
    expect(registerWorker).not.toHaveBeenCalled();
  });

  it("still lets the person refuse it outright", async () => {
    const response = await POST(request({ deny: true }), ctx());

    expect(await response.json()).toEqual({ state: "denied" });
    expect(registerWorker).not.toHaveBeenCalled();
  });
});
