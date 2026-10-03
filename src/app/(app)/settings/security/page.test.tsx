// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import SecurityPage from "./page";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("@/components/auth/ProviderButtons", () => ({ ProviderButtons: () => <div>provider buttons</div> }));
const passwordSignIn = vi.hoisted(() => ({ value: true as boolean | null }));
vi.mock("@/hooks/use-password-sign-in", () => ({ usePasswordSignIn: () => passwordSignIn.value }));

const METHODS = { hasPassword: true, passwordSignIn: true, mailWorks: true, identities: [] };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(METHODS);
  passwordSignIn.value = true;
});
afterEach(cleanup);

// BP-844
describe("Settings → Security", () => {
  it("keeps the password form when the sign-in providers cannot be read", async () => {
    api.get.mockRejectedValue(new Error("down"));

    render(<SecurityPage />);

    expect(await screen.findByText("Could not load your sign-in providers. Reload the page to try again.")).toBeTruthy();
    expect(screen.getByLabelText("Current password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  });

  it("offers no password form from a failed read where passwords sign nobody in", async () => {
    api.get.mockRejectedValue(new Error("down"));
    passwordSignIn.value = false;

    render(<SecurityPage />);

    expect(await screen.findByText("Could not load your sign-in providers. Reload the page to try again.")).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
  });

  it("sends an account with no password to Forgot your password while mail goes out", async () => {
    api.get.mockResolvedValue({ ...METHODS, hasPassword: false });

    render(<SecurityPage />);

    expect(await screen.findByRole("link", { name: "Forgot your password" })).toBeTruthy();
  });

  it("sends it to an administrator instead when this instance sends no mail", async () => {
    api.get.mockResolvedValue({ ...METHODS, hasPassword: false, mailWorks: false });

    render(<SecurityPage />);

    expect(await screen.findByText(/this instance sends no mail\. Ask an administrator to set one\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Forgot your password" })).toBeNull();
  });
});
