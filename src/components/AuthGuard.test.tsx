// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { AuthGuard } from "@/components/AuthGuard";

const { nav, auth } = vi.hoisted(() => ({
  nav: { replace: vi.fn() },
  auth: {
    user: null as { username: string } | null,
    isAdmin: false,
    isLoading: false,
    outage: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    onUnauthorized: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/projects/BP",
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));

function renderGuard() {
  return render(
    <AuthGuard>
      <span data-testid="app">the board</span>
    </AuthGuard>
  );
}

describe("AuthGuard", () => {
  beforeEach(() => {
    nav.replace.mockClear();
    auth.refreshUser.mockClear();
    auth.refreshUser.mockResolvedValue(undefined);
    auth.user = null;
    auth.isLoading = false;
    auth.outage = false;
    window.history.replaceState({}, "", "/projects/BP?column=active");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the app for a signed-in user", () => {
    auth.user = { username: "rpo" };

    renderGuard();

    expect(screen.getByTestId("app")).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign in, carrying where they were going", () => {
    renderGuard();

    expect(nav.replace).toHaveBeenCalledWith(
      "/login?next=" + encodeURIComponent("/projects/BP?column=active")
    );
  });

  // The whole point of BP-362: during an outage the server never said anything about the session,
  // so there is nothing to redirect on — and the sign-in page it would land on is served by the
  // same instance that cannot reach its database
  it("does not redirect while the instance cannot answer", () => {
    auth.outage = true;

    renderGuard();

    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("says the instance is having trouble, and that nobody was signed out", () => {
    auth.outage = true;

    renderGuard();

    expect(screen.getByText(/this instance is having trouble/i)).toBeTruthy();
    expect(screen.getByText(/have not been signed out/i)).toBeTruthy();
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("offers a retry that asks again", async () => {
    auth.outage = true;

    renderGuard();
    await act(async () => {
      screen.getByRole("button", { name: /try again/i }).click();
    });

    expect(auth.refreshUser).toHaveBeenCalled();
  });

  it("keeps trying by itself, so the app comes back without a reload", async () => {
    vi.useFakeTimers();
    auth.outage = true;

    renderGuard();
    expect(auth.refreshUser).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });

    expect(auth.refreshUser.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops retrying once somebody is signed in again", async () => {
    vi.useFakeTimers();
    auth.outage = true;
    auth.user = { username: "rpo" };

    renderGuard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(auth.refreshUser).not.toHaveBeenCalled();
    expect(screen.getByTestId("app")).toBeTruthy();
  });

  it("shows the spinner and decides nothing while the first answer is outstanding", () => {
    auth.isLoading = true;

    renderGuard();

    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("app")).toBeNull();
  });
});
