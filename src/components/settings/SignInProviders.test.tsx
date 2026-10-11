// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SignInProviders } from "./SignInProviders";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const BOTH_ON = {
  hosted: true,
  enforced: false,
  providers: [
    { id: "google", label: "Google", enabled: true },
    { id: "github", label: "GitHub", enabled: true },
  ],
};
const GOOGLE_OFF = { ...BOTH_ON, providers: [{ id: "google", label: "Google", enabled: false }, BOTH_ON.providers[1]] };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(BOTH_ON);
});
afterEach(cleanup);

// The hint is part of the label, so the name starts with the title
const switchFor = (name: string) => screen.findByRole("switch", { name: new RegExp(`^${name}`) }) as Promise<HTMLInputElement>;

describe("Settings → Single sign-on, Google and GitHub (BP-1027)", () => {
  it("shows one switch per provider, each on until it is switched off", async () => {
    render(<SignInProviders />);

    expect((await switchFor("Sign in with Google")).checked).toBe(true);
    expect((await switchFor("Sign in with GitHub")).checked).toBe(true);
  });

  it("shows nothing where the instance is not the cloud", async () => {
    api.get.mockResolvedValue({ hosted: false });
    const { container } = render(<SignInProviders />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows nothing where the operator set up neither provider", async () => {
    api.get.mockResolvedValue({ hosted: true, enforced: false, providers: [] });
    const { container } = render(<SignInProviders />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("switches a provider off, and says so", async () => {
    api.put.mockResolvedValue(GOOGLE_OFF);
    render(<SignInProviders />);

    fireEvent.click(await switchFor("Sign in with Google"));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/sign-in-providers", { provider: "google", enabled: false, confirm: false }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Sign-in with Google turned off", "success"));
    expect((await switchFor("Sign in with Google")).checked).toBe(false);
  });

  it("asks before switching off a provider somebody could only sign in through, naming how many, and then does it", async () => {
    const refusal = Object.assign(new Error("2 members sign in only through Google. They cannot sign in while it is off."), { status: 409, body: { affected: 2 } });
    api.put.mockRejectedValueOnce(refusal).mockResolvedValueOnce(GOOGLE_OFF);
    render(<SignInProviders />);

    fireEvent.click(await switchFor("Sign in with Google"));

    expect(await screen.findByText(/2 members sign in only through Google/)).toBeTruthy();
    expect((await switchFor("Sign in with Google")).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith("/api/settings/sign-in-providers", { provider: "google", enabled: false, confirm: true }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Sign-in with Google turned off", "success"));
  });

  it("leaves the provider on when the question is dismissed", async () => {
    api.put.mockRejectedValueOnce(Object.assign(new Error("1 member signs in only through Google."), { status: 409, body: { affected: 1 } }));
    render(<SignInProviders />);

    fireEvent.click(await switchFor("Sign in with Google"));
    await screen.findByText(/1 member signs in only through Google/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(api.put).toHaveBeenCalledTimes(1);
    expect((await switchFor("Sign in with Google")).checked).toBe(true);
  });

  it("says why when the save failed for any other reason, and keeps the switch where it was", async () => {
    api.put.mockRejectedValueOnce(Object.assign(new Error("Interactive admin session required"), { status: 403, body: {} }));
    render(<SignInProviders />);

    fireEvent.click(await switchFor("Sign in with GitHub"));

    expect((await screen.findByRole("alert")).textContent).toBe("Interactive admin session required");
    expect((await switchFor("Sign in with GitHub")).checked).toBe(true);
  });

  it("says Google and GitHub are closed while single sign-on is required", async () => {
    api.get.mockResolvedValue({ ...BOTH_ON, enforced: true });
    render(<SignInProviders />);

    expect((await screen.findByTestId("sign-in-providers-enforced")).textContent).toContain("Single sign-on is required");
  });

  it("says it could not read the switches, and tries again", async () => {
    api.get.mockRejectedValueOnce(new Error("boom"));
    render(<SignInProviders />);

    fireEvent.click(await screen.findByRole("button", { name: /retry|try again/i }));

    expect((await switchFor("Sign in with Google")).checked).toBe(true);
  });
});
