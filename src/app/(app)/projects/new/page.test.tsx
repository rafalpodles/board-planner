// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { AuthState } from "@/hooks/use-auth";
import type { ApiUser } from "@/types";

const { api, nav, auth } = vi.hoisted(() => ({
  api: { post: vi.fn() },
  nav: { replace: vi.fn(), back: vi.fn(), push: vi.fn() },
  // Annotated, so a field added to AuthState fails here instead of reaching the component as
  // undefined with the suite green
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

// BP-534: this page used to read no auth state at all, so a member reached the full form by URL
// and was only refused after posting.
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

describe("the key", () => {
  const nameField = () => screen.getByLabelText("Project Name") as HTMLInputElement;
  const keyField = () => screen.getByLabelText("Project Key") as HTMLInputElement;

  it("is suggested from the name as it is typed", () => {
    render(<NewProjectPage />);

    fireEvent.change(nameField(), { target: { value: "Orbit" } });
    expect(keyField().value).toBe("ORB");

    fireEvent.change(nameField(), { target: { value: "Orbit Launch" } });
    expect(keyField().value).toBe("OL");
  });

  it("is never overwritten once the person has typed their own", () => {
    render(<NewProjectPage />);

    fireEvent.change(nameField(), { target: { value: "Orbit" } });
    fireEvent.change(keyField(), { target: { value: "sat" } });
    fireEvent.change(nameField(), { target: { value: "Orbit Launch" } });

    expect(keyField().value).toBe("SAT");
  });

  it("follows the name again after the typed key is cleared", () => {
    render(<NewProjectPage />);

    fireEvent.change(keyField(), { target: { value: "SAT" } });
    fireEvent.change(keyField(), { target: { value: "" } });
    fireEvent.change(nameField(), { target: { value: "Orbit" } });

    expect(keyField().value).toBe("ORB");
  });

  it("says it is permanent, with the task keys it will produce", () => {
    render(<NewProjectPage />);

    fireEvent.change(nameField(), { target: { value: "Orbit" } });

    expect(keyField().getAttribute("aria-describedby")).toBe("project-key-hint");
    expect(document.getElementById("project-key-hint")?.textContent).toBe(
      "Task keys are built from it (ORB-1, ORB-2…) and it cannot change later."
    );
  });
});
