import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { headers, redirect, servedOrganisationById } = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  servedOrganisationById: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/components/auth/PlatformSignIn", () => ({ PlatformSignIn: () => null }));
vi.mock("@/lib/platform-sign-in", async (original) => ({ ...(await original<typeof import("@/lib/platform-sign-in")>()), servedOrganisationById }));

const { default: Home } = await import("./page");
const { PlatformSignIn } = await import("@/components/auth/PlatformSignIn");

const GLOBEX = { id: "0000000000000000000000b2", name: "Globex", slug: "globex", origin: "https://globex.board-planner.com" };

function requestFrom(host: string, cookie: string | null) {
  headers.mockResolvedValue(new Headers({ host, ...(cookie ? { cookie } : {}) }));
}

const home = (query: { switch?: string } = {}) => Home({ searchParams: Promise.resolve(query) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ORGANISATION_DOMAIN = "board-planner.com";
  process.env.COOKIE_ALLOW_INSECURE = "1";
});

afterEach(() => {
  delete process.env.ORGANISATION_DOMAIN;
  delete process.env.COOKIE_ALLOW_INSECURE;
});

describe("the platform host's front page (BP-1009)", () => {
  it("sends a remembered organisation's person straight to its board", async () => {
    requestFrom("login.board-planner.com", "bp_last_organisation=" + GLOBEX.id);
    servedOrganisationById.mockResolvedValue(GLOBEX);

    await expect(home()).rejects.toThrow("redirect:https://globex.board-planner.com/projects");
    expect(servedOrganisationById).toHaveBeenCalledWith(GLOBEX.id);
  });

  it("keeps its own page on ?switch, so another organisation can be chosen, without asking which one was remembered", async () => {
    requestFrom("login.board-planner.com", "bp_last_organisation=" + GLOBEX.id);

    const page = await home({ switch: "" });

    expect(page).toMatchObject({ type: PlatformSignIn });
    expect(servedOrganisationById).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing remembered", null, null],
    ["an organisation that is suspended, deleted or unknown", "bp_last_organisation=0123456789abcdef01234567", null],
  ])("shows the sign-in for %s", async (_case, cookie, served) => {
    requestFrom("login.board-planner.com", cookie);
    servedOrganisationById.mockResolvedValue(served);

    expect(await home()).toMatchObject({ type: PlatformSignIn });
  });

  it("shows the sign-in when the database cannot say, instead of an error page", async () => {
    requestFrom("login.board-planner.com", "bp_last_organisation=" + GLOBEX.id);
    servedOrganisationById.mockRejectedValue(new Error("connect ECONNREFUSED"));

    expect(await home()).toMatchObject({ type: PlatformSignIn });
  });

  it("is untouched on an organisation's own host, which goes to its projects without asking anything", async () => {
    requestFrom("globex.board-planner.com", "bp_last_organisation=" + GLOBEX.id);

    await expect(home()).rejects.toThrow("redirect:/projects");
    expect(servedOrganisationById).not.toHaveBeenCalled();
  });
});
