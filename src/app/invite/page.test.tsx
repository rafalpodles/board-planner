// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

const { auth, fetchMock, passwordSignIn, legalTerms } = vi.hoisted(() => ({
  passwordSignIn: { value: true as boolean | null },
  legalTerms: { value: null as null | Record<string, string> },
  auth: { user: null, isLoading: false, logout: vi.fn(), refreshUser: vi.fn() },
  fetchMock: vi.fn(),
}));

vi.mock("@/hooks/use-password-sign-in", () => ({ usePasswordSignIn: () => passwordSignIn.value }));
vi.mock("@/hooks/use-legal-terms", () => ({ useLegalTerms: () => ({ terms: legalTerms.value, failed: false, retry: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("token=cpi_held"),
}));

const { default: InvitePage } = await import("./page");

function answer(status: number, body?: unknown) {
  return Promise.resolve(
    new Response(body === undefined ? "not json" : JSON.stringify(body), { status })
  );
}

const OPEN = { email: "ada@example.com", role: "member", boards: [], invitedBy: "Grace" };

beforeEach(() => {
  vi.clearAllMocks();
  passwordSignIn.value = true;
  legalTerms.value = null;
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the invitation page", () => {
  it("shows the form for an open invitation", async () => {
    fetchMock.mockReturnValue(answer(200, OPEN));

    render(<InvitePage />);

    expect(await screen.findByText(/Grace invited ada@example.com/)).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: "cpi_held" });
  });

  it("says why a refused link cannot be used", async () => {
    fetchMock.mockReturnValue(
      answer(400, { error: "This invitation has expired. Ask whoever invited you for a new one.", reason: "expired" })
    );

    render(<InvitePage />);

    expect(await screen.findByText("This invitation cannot be used")).toBeTruthy();
    expect(
      screen.getByText("This invitation has expired. Ask whoever invited you for a new one.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  // The token has already left the address bar, so a reload cannot recover it: an outage must not
  // be told to the invitee as a dead link, and has to be retryable from the token held in memory
  it("offers to try again when the server failed, and the retry uses the held token", async () => {
    fetchMock.mockReturnValueOnce(answer(500)).mockReturnValueOnce(answer(200, OPEN));

    render(<InvitePage />);

    expect(await screen.findByText("The invitation could not be loaded")).toBeTruthy();
    expect(screen.queryByText("This invitation cannot be used")).toBeNull();

    await act(async () => screen.getByRole("button", { name: "Try again" }).click());

    expect(await screen.findByText(/Grace invited ada@example.com/)).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ token: "cpi_held" });
  });

  it("treats being throttled as retryable, not as a dead link", async () => {
    fetchMock.mockReturnValue(answer(429, { error: "Too many attempts. Try again in 15 minutes." }));

    render(<InvitePage />);

    expect(await screen.findByText("Too many attempts. Try again in 15 minutes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("This invitation cannot be used")).toBeNull();
  });
});

describe("the invitation page with password sign-in off (BP-830)", () => {
  it("offers no password form, only the providers", async () => {
    passwordSignIn.value = false;
    fetchMock.mockImplementation((url: string) =>
      url === "/api/auth/oidc/providers" ? answer(200, [{ id: "oidc", label: "Acme" }]) : answer(200, OPEN)
    );

    render(<InvitePage />);

    expect(await screen.findByRole("button", { name: "Accept with Acme" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create my account" })).toBeNull();
  });
});

describe("the invitation page with the cloud terms published (BP-939)", () => {
  const TERMS = {
    version: "2026-10-15",
    terms: "https://board-planner.com/legal/terms",
    privacy: "https://board-planner.com/legal/privacy",
    termsPl: "https://board-planner.com/legal/terms/pl",
    privacyPl: "https://board-planner.com/legal/privacy/pl",
  };

  it("offers an unticked box linking both documents, and sends what it says", async () => {
    legalTerms.value = TERMS;
    fetchMock.mockReturnValue(answer(200, OPEN));

    render(<InvitePage />);

    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.required).toBe(true);
    expect(screen.getByRole("link", { name: "Terms of Service" }).getAttribute("href")).toBe(TERMS.terms);
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe(TERMS.privacy);
    expect(screen.getAllByRole("link", { name: "Polski" }).map((a) => a.getAttribute("href"))).toEqual([TERMS.termsPl, TERMS.privacyPl]);

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a-long-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a-long-password" } });
    fireEvent.click(box);
    fetchMock.mockReturnValue(answer(201, { username: "ada", landing: null }));
    await act(async () => fireEvent.submit(box.form!));

    const sent = fetchMock.mock.calls.find(([url]) => url === "/api/invitations/accept");
    expect(JSON.parse(sent![1].body)).toMatchObject({ acceptTerms: true });
  });

  it("shows no box where no terms are published", async () => {
    fetchMock.mockReturnValue(answer(200, OPEN));

    render(<InvitePage />);

    expect(await screen.findByText(/Grace invited ada@example.com/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
