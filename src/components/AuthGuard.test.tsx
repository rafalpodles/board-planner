// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { AuthGuard } from "@/components/AuthGuard";
import type { AuthState } from "@/hooks/use-auth";
import type { ApiUser } from "@/types";

const { nav, auth } = vi.hoisted(() => ({
  nav: { replace: vi.fn() },
  // Annotated, so a field added to AuthState fails here instead of reaching the component as
  // undefined with the suite green
  auth: {
    user: null as ApiUser | null,
    isAdmin: false,
    isLoading: false as boolean,
    outage: false as boolean,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    onUnauthorized: vi.fn(),
    noteApiStatus: vi.fn(),
    // satisfies, not `as`: this checks the mock is still a whole AuthState while leaving the
    // members their mock types, so `refreshUser.mockClear()` still type-checks
  } satisfies AuthState,
}));

const SIGNED_IN = { username: "rpo" } as ApiUser;

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
    auth.user = SIGNED_IN;

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
      await vi.advanceTimersByTimeAsync(10_100);
    });
    expect(auth.refreshUser).toHaveBeenCalledTimes(1);

    // Backed off, not every 10 s: /api/auth/me can take seconds to fail during an outage, and a
    // fixed interval left several in flight at once on a tab nobody was watching
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });
    expect(auth.refreshUser).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(auth.refreshUser).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when the panel goes away, rather than polling a closed tab forever", async () => {
    vi.useFakeTimers();
    auth.outage = true;

    const { unmount } = renderGuard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });
    expect(auth.refreshUser).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(auth.refreshUser).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once somebody is signed in again", async () => {
    vi.useFakeTimers();
    auth.outage = true;
    auth.user = SIGNED_IN;

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

// Nobody already signed in is sent back through /api/auth/me, so the panel above can never appear
// for them. Without this they saw only each screen failing to load, for its own invented reason.
describe("AuthGuard while signed in", () => {
  beforeEach(() => {
    nav.replace.mockClear();
    auth.refreshUser.mockClear();
    auth.user = SIGNED_IN;
    auth.isLoading = false;
    auth.outage = false;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("says the instance is in trouble without taking the app away", () => {
    auth.outage = true;

    renderGuard();

    expect(screen.getByText(/having trouble reaching its database/i)).toBeTruthy();
    expect(screen.getByText(/still signed in/i)).toBeTruthy();
    // The board stays: a transient 500 must not blank what somebody is working on
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("says nothing while everything is answering", () => {
    renderGuard();

    expect(screen.queryByText(/having trouble/i)).toBeNull();
    expect(screen.getByTestId("app")).toBeTruthy();
  });

  it("does not poll while somebody is working — their own requests report the truth", async () => {
    vi.useFakeTimers();
    auth.outage = true;

    renderGuard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(auth.refreshUser).not.toHaveBeenCalled();
  });
});
