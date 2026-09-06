// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveSession = vi.fn();
const projects = [
  { _id: "p1", name: "Orbit", key: "ORB" },
  { _id: "p2", name: "Mobile App", key: "MOB" },
];

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/auth", () => ({ verifyCredentials: vi.fn(), getClientIp: () => "203.0.113.7" }));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/security-mail", () => ({ notifyCredentialCreated: vi.fn() }));
vi.mock("@/models/oauthClient", () => ({
  OAuthClient: {
    findOne: vi
      .fn()
      .mockResolvedValue({
        clientId: "c1",
        clientName: "Some App",
        redirectUris: ["https://client.example/callback"],
      }),
  },
}));
vi.mock("@/models/oauthCode", () => ({ OAuthCode: { create: vi.fn() } }));
vi.mock("@/models/oauthConsent", () => ({
  OAuthConsent: { create: vi.fn(), findOne: vi.fn(), deleteOne: vi.fn() },
}));
vi.mock("@/models/user", () => ({
  User: { findById: vi.fn().mockResolvedValue({ _id: "u1", username: "victim", role: "member" }) },
}));
vi.mock("@/models/project", () => ({
  Project: { find: () => ({ select: () => ({ sort: () => ({ lean: async () => projects }) }) }) },
}));
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  resolveSession,
}));

const { GET } = await import("./route");
const { sessionCookieName } = await import("@/lib/session");
const { resetRateLimits } = await import("@/lib/rate-limit");

async function renderConsentPage(): Promise<void> {
  resolveSession.mockResolvedValue({ userId: "u1", sessionId: "s1" });
  const query = new URLSearchParams({
    client_id: "c1",
    redirect_uri: "https://client.example/callback",
    state: "s",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    response_type: "code",
    scope: "mcp",
  });
  const cookie = `${sessionCookieName()}=cps_live-token`;
  const req = {
    url: `http://localhost/oauth/authorize?${query.toString()}`,
    method: "GET",
    headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? cookie : null) },
  } as unknown as Request;

  const html = await (await GET(req)).text();

  expect(html).toContain("Grant access");
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html>|<\/html>[\s\S]*$/g, "");

  for (const script of Array.from(document.querySelectorAll("script"))) {
    new Function(script.textContent ?? "")();
  }
}

function state() {
  const boxes = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="projects"]')
  );
  return {
    ignored: document.getElementById("projects")?.getAttribute("data-ignored"),
    disabled: boxes.map((b) => b.disabled),
    limited: document.querySelector<HTMLInputElement>('input[name="access"][value="limited"]')
      ?.checked,
  };
}

function pick(value: "limited" | "all") {
  const radio = document.querySelector<HTMLInputElement>(`input[name="access"][value="${value}"]`)!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(async () => {
  await resetRateLimits();
  await renderConsentPage();
});

describe("the consent screen's inline script", () => {
  it("starts with the project list live", () => {
    expect(state()).toEqual({ ignored: "false", disabled: [false, false], limited: true });
  });

  it("deactivates the list when the wide grant is picked, and restores it", () => {
    pick("all");
    expect(state()).toEqual({ ignored: "true", disabled: [true, true], limited: false });

    pick("limited");
    expect(state()).toEqual({ ignored: "false", disabled: [false, false], limited: true });
  });

  it("comes back to the narrow grant when the deactivated list is clicked", () => {
    pick("all");

    document.getElementById("projects")!.dispatchEvent(new Event("click", { bubbles: true }));

    expect(state()).toEqual({ ignored: "false", disabled: [false, false], limited: true });
  });

  it("makes Authorize the button Enter presses, with Deny still on the left", () => {
    const form = document.getElementById("consent") as HTMLFormElement;
    const buttons = Array.from(form.querySelectorAll("button"));

    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.value).toBe("allow");
    expect(buttons.map((b) => b.value)).toEqual(["allow", "deny"]);
    expect(document.querySelector("style")!.textContent).toContain("flex-direction:row-reverse");
  });

  it("keeps the disabled squares out of hit-testing so no spot in the list is dead", () => {
    const css = document.querySelector("style")!.textContent ?? "";

    expect(css).toContain(".projects[data-ignored=true] input{pointer-events:none}");
  });

  it("re-syncs when the page is restored from history", () => {
    pick("all");
    const restored = document.querySelector<HTMLInputElement>(
      'input[name="access"][value="all"]'
    )!;
    restored.checked = true;
    document.getElementById("projects")!.setAttribute("data-ignored", "false");
    for (const box of Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="projects"]')
    )) {
      box.disabled = false;
    }

    window.dispatchEvent(new Event("pageshow"));

    expect(state()).toEqual({ ignored: "true", disabled: [true, true], limited: false });
  });
});
