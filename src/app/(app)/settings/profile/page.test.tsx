// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import ProfilePage from "./page";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { _id: "u1", username: "ada" }, refreshUser: vi.fn() }) }));
vi.mock("@/hooks/use-password-sign-in", () => ({ usePasswordSignIn: () => true }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const answers = (hasPassword: boolean) =>
  api.get.mockImplementation((path: string) => {
    if (path === "/api/auth/me") return Promise.resolve({ email: "ada@example.com", fullName: "Ada" });
    if (path === "/api/users/me/identities") return Promise.resolve({ hasPassword, passwordSignIn: true, identities: [] });
    return Promise.resolve({ pending: null });
  });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

// BP-844. Changing the address asks for a password, which an account made through a provider lacks
describe("changing the address on Profile", () => {
  it("asks an account with a password for it", async () => {
    answers(true);
    render(<ProfilePage />);
    const email = (await screen.findByDisplayValue("ada@example.com")) as HTMLInputElement;

    fireEvent.change(email, { target: { value: "new@example.com" } });

    expect(screen.getByLabelText("Current password")).toBeTruthy();
  });

  it("tells an account with no password how to change it, rather than asking for one", async () => {
    answers(false);
    render(<ProfilePage />);
    const email = (await screen.findByDisplayValue("ada@example.com")) as HTMLInputElement;
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/users/me/identities"));

    fireEvent.change(email, { target: { value: "new@example.com" } });

    expect(await screen.findByText(/this account has none/)).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
  });
});
