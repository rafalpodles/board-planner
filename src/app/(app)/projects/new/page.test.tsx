// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AuthState } from "@/hooks/use-auth";
import type { ApiUser } from "@/types";

const { api, nav, auth } = vi.hoisted(() => ({
  api: { post: vi.fn() },
  nav: { replace: vi.fn(), back: vi.fn(), push: vi.fn() },
  auth: {
    user: null as ApiUser | null,
    isAdmin: true as boolean,
    isLoading: false as boolean,
    outage: false as boolean,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    onUnauthorized: vi.fn(),
    noteApiStatus: vi.fn(),
  } satisfies AuthState,
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const { default: NewProjectPage } = await import("./page");

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = true;
  auth.isLoading = false;
});

afterEach(cleanup);

describe("the admin gate", () => {
  it("renders the form for an admin", () => {
    render(<NewProjectPage />);

    expect(screen.getByRole("heading", { name: "New project" })).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("sends a non-admin to /projects and renders nothing", () => {
    auth.isAdmin = false;

    render(<NewProjectPage />);

    expect(nav.replace).toHaveBeenCalledWith("/projects");
    expect(screen.queryByRole("heading", { name: "New project" })).toBeNull();
  });

  it("decides nothing while the first answer is outstanding", () => {
    auth.isAdmin = false;
    auth.isLoading = true;

    render(<NewProjectPage />);

    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "New project" })).toBeNull();
  });
});
