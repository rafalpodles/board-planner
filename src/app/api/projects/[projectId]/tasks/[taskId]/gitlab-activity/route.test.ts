import { describe, it, expect, vi, beforeEach } from "vitest";

const { decryptSecret, fetchTaskBranches, fetchTaskCommits } = vi.hoisted(() => ({
  decryptSecret: vi.fn(),
  fetchTaskBranches: vi.fn(),
  fetchTaskCommits: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret }));
vi.mock("@/lib/gitlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gitlab")>()),
  fetchTaskBranches,
  fetchTaskCommits,
}));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request, ctx: unknown) =>
      handler(req, {
        ...(ctx as object),
        db: {
          organisation: "org",
          Project: {
            findById: () => ({
              lean: () =>
                Promise.resolve({
                  key: "BP",
                  repositoryUrl: "https://gitlab.com/g/p",
                  gitlabToken: "stored",
                  gitlabHost: "https://gitlab.com",
                }),
            }),
          },
          Task: { findOne: () => ({ lean: () => Promise.resolve({ taskNumber: 5 }) }) },
        },
      }),
}));

const { GET } = await import("./route");

const call = () =>
  GET(new Request("http://localhost/api"), { params: Promise.resolve({ projectId: "p1", taskId: "t1" }) } as never);

beforeEach(() => {
  vi.clearAllMocks();
  fetchTaskBranches.mockResolvedValue([]);
  fetchTaskCommits.mockResolvedValue([]);
});

describe("GET .../gitlab-activity — the stored token", () => {
  it("is decrypted before it is sent to GitLab", async () => {
    decryptSecret.mockReturnValue("glpat-real");

    const res = await call();

    expect(res.status).toBe(200);
    expect(fetchTaskBranches).toHaveBeenCalledWith("https://gitlab.com", "g/p", "glpat-real", "BP-5");
  });

  it("answers 502 with a sentence when it can no longer be read, and calls GitLab with nothing", async () => {
    decryptSecret.mockImplementation(() => {
      throw new Error("This secret was stored before secrets were sealed per organisation and can no longer be read. Re-enter it.");
    });

    const res = await call();

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      error: "The stored GitLab token can no longer be read. Enter it again in project settings.",
    });
    expect(fetchTaskBranches).not.toHaveBeenCalled();
    expect(fetchTaskCommits).not.toHaveBeenCalled();
  });
});
