import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectLean = vi.fn();
const workerFind = vi.fn();
const taskExists = vi.fn();
const grantCount = vi.fn();
const sprintExists = vi.fn();
const tokenExists = vi.fn();
const oauthExists = vi.fn();
const userLean = vi.fn();
const userUpdate = vi.fn();
const settingsLean = vi.fn();
const getOrganisation = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check, accessibleProjectIds: vi.fn() };
});
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("@/models/project", () => ({
  Project: { findOne: () => ({ lean: projectLean }) },
}));
vi.mock("@/models/worker", () => ({
  Worker: { find: (...a: unknown[]) => (workerFind(...a), { lean: async () => [] }) },
}));
vi.mock("@/models/task", () => ({ Task: { exists: taskExists } }));
vi.mock("@/models/grant", () => ({ Grant: { countDocuments: grantCount } }));
vi.mock("@/models/sprint", () => ({ Sprint: { exists: sprintExists } }));
vi.mock("@/models/apiToken", () => ({ ApiToken: { exists: tokenExists } }));
vi.mock("@/models/oauthToken", () => ({ OAuthToken: { exists: oauthExists } }));
vi.mock("@/models/settings", () => ({ Settings: { findOne: () => ({ lean: settingsLean }) } }));
vi.mock("@/models/user", () => ({
  User: { findOne: () => ({ lean: userLean }), updateOne: userUpdate },
}));

const { GET, PUT } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });
const READER = "507f1f77bcf86cd799439011";

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: READER, role: "member" });
  check.mockImplementation(async () => true);
  projectLean.mockResolvedValue({ _id: PROJECT, repositoryUrl: "", worker: { enabled: false } });
  taskExists.mockResolvedValue(null);
  grantCount.mockResolvedValue(1);
  sprintExists.mockResolvedValue(null);
  tokenExists.mockResolvedValue(null);
  oauthExists.mockResolvedValue(null);
  userLean.mockResolvedValue({ dismissedSetupGuides: [] });
  settingsLean.mockResolvedValue(null);
  getOrganisation.mockResolvedValue({ entitlements: { plan: "free" } });
});

async function read() {
  const res = await GET(new Request("http://x"), { params });
  return { status: res.status, body: await res.json() };
}

const doneOf = (body: { steps: { id: string; done: boolean }[] }) =>
  Object.fromEntries(body.steps.map((s) => [s.id, s.done]));

describe("GET setup guide", () => {
  it("answers nothing, and reads nothing, for somebody who may not change the board", async () => {
    check.mockImplementation(async (_db: unknown, _user: unknown, _project: string, need: string) => need === "access");

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body).toEqual({ show: false, steps: [] });
    expect(projectLean).not.toHaveBeenCalled();
    expect(grantCount).not.toHaveBeenCalled();
    expect(workerFind).not.toHaveBeenCalled();
    expect(settingsLean).not.toHaveBeenCalled();
  });

  it("derives each step from what exists and asks only about the reader's own machines and tokens", async () => {
    taskExists.mockResolvedValue({ _id: "t" });
    grantCount.mockResolvedValue(2);
    sprintExists.mockResolvedValue({ _id: "s" });
    tokenExists.mockResolvedValue({ _id: "k" });
    projectLean.mockResolvedValue({
      _id: PROJECT,
      repositoryUrl: "",
      worker: { enabled: false },
      webhooks: [{ url: "https://x" }],
      notificationChannels: [],
      pm: { enabled: true },
    });

    const { body } = await read();

    expect(body.show).toBe(true);
    expect(doneOf(body)).toMatchObject({
      tasks: true,
      team: true,
      sprint: true,
      token: true,
      webhook: true,
      channel: false,
      repository: false,
      runs: false,
      machine: false,
    });
    expect(workerFind.mock.calls[0][0]).toEqual({ owner: READER, organisation: DEFAULT_ORGANISATION_ID });
    expect(tokenExists.mock.calls[0][0]).toEqual({ user: READER, organisation: DEFAULT_ORGANISATION_ID });
  });

  it("counts an OAuth connection as a token", async () => {
    oauthExists.mockResolvedValue({ _id: "o" });

    expect(doneOf((await read()).body).token).toBe(true);
  });

  it("leaves the organisation's steps out for somebody who is not an instance admin", async () => {
    const { body } = await read();

    expect(body.steps.map((s: { id: string }) => s.id)).not.toEqual(expect.arrayContaining(["sso"]));
    expect(settingsLean).not.toHaveBeenCalled();
    expect(getOrganisation).not.toHaveBeenCalled();
  });

  it("adds the AI key for an instance admin, and leaves sso and the plan out where nothing is hosted", async () => {
    getAuthUser.mockResolvedValue({ _id: READER, role: "admin" });
    settingsLean.mockResolvedValue({ openrouterKey: "sealed", sso: { issuer: "https://idp" } });
    projectLean.mockResolvedValue({ _id: PROJECT, repositoryUrl: "", worker: { enabled: false }, pm: { enabled: true } });

    const { body } = await read();

    expect(doneOf(body)).toMatchObject({ aiKey: true, pm: true });
    const ids = body.steps.map((s: { id: string }) => s.id);
    expect(ids).not.toContain("sso");
    expect(ids).not.toContain("plan");
  });

  it("is hidden for a person who hid it, though steps are still open", async () => {
    userLean.mockResolvedValue({ dismissedSetupGuides: [PROJECT] });

    const { body } = await read();

    expect(body.show).toBe(false);
    expect(body.steps.some((s: { done: boolean }) => !s.done)).toBe(true);
  });

  it("answers 404 for a board that is gone", async () => {
    projectLean.mockResolvedValue(null);

    expect((await read()).status).toBe(404);
  });
});

describe("PUT setup guide", () => {
  const hide = () => PUT(new Request("http://x", { method: "PUT" }), { params });

  it("records the board against the reader, bounded", async () => {
    const res = await hide();

    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = userUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: READER, organisation: DEFAULT_ORGANISATION_ID });
    expect(update).toEqual({ $push: { dismissedSetupGuides: { $each: [PROJECT], $slice: -200 } } });
  });

  it("does not record it twice", async () => {
    userLean.mockResolvedValue({ dismissedSetupGuides: [PROJECT] });

    expect((await hide()).status).toBe(200);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
