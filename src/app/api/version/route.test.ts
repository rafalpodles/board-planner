import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getAuthUser } = vi.hoisted(() => ({ getAuthUser: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { GET } = await import("./route");

function get() {
  return GET(new Request("http://localhost/api/version"), { params: Promise.resolve({}) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/version", () => {
  it("401s without credentials, so an anonymous caller cannot ask what runs here", async () => {
    getAuthUser.mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(401);
  });

  it("answers version, commit and start time to any signed-in member", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", username: "member", role: "member" });
    vi.stubEnv("GIT_SHA", "951c99b6a1d2e3f40718293a4b5c6d7e8f901234");

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      sha: "951c99b6a1d2e3f40718293a4b5c6d7e8f901234",
      shortSha: "951c99b",
      startedAt: expect.any(String),
    });
  });

  it("reads the commit when asked, not once at import, so a value set after boot is not frozen in", async () => {
    getAuthUser.mockResolvedValue({ _id: "u1", username: "member", role: "member" });

    vi.stubEnv("GIT_SHA", "");
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "");
    expect((await (await get()).json()).sha).toBe("unknown");

    vi.stubEnv("GIT_SHA", "abcdef0123456789abcdef0123456789abcdef01");
    expect((await (await get()).json()).sha).toBe("abcdef0123456789abcdef0123456789abcdef01");
  });
});
