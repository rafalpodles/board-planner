// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const { auth, fetchMock } = vi.hoisted(() => ({
  auth: { user: null, isLoading: false, logout: vi.fn(), refreshUser: vi.fn() },
  fetchMock: vi.fn(),
}));

vi.mock("@/hooks/use-password-sign-in", () => ({ usePasswordSignIn: () => true }));
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
