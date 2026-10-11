// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SingleSignOn } from "./SingleSignOn";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const PRO_EMPTY = {
  hosted: true, plan: "pro", trial: false, trialEndsAt: null, available: true, set: false, issuer: "", clientId: "", label: "Single sign-on",
  secretHint: "", unreadable: false, active: false, redirectUri: "https://acme.board.example/api/auth/oidc/oidc/callback",
};
const SAVED = { ...PRO_EMPTY, set: true, active: true, issuer: "https://login.acme.example", clientId: "acme-app", label: "Acme login", secretHint: "1234" };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(PRO_EMPTY);
});
afterEach(cleanup);

const field = (name: string) => screen.findByLabelText(name) as Promise<HTMLInputElement>;
const type = (el: HTMLInputElement, value: string) => fireEvent.change(el, { target: { value } });

describe("Settings → Single sign-on (BP-951)", () => {
  it("shows the redirect URI to register and a form on a plan that includes it", async () => {
    render(<SingleSignOn />);

    expect((await screen.findByTestId("sso-redirect")).textContent).toContain("https://acme.board.example/api/auth/oidc/oidc/callback");
    expect(await field("Issuer")).toBeTruthy();
    expect(screen.queryByTestId("sso-upgrade")).toBeNull();
  });

  it("sends what was typed, with the secret, and says it was saved", async () => {
    api.put.mockResolvedValue(SAVED);
    render(<SingleSignOn />);

    type(await field("Button name"), "Acme login");
    type(await field("Issuer"), "https://login.acme.example");
    type(await field("Client ID"), "acme-app");
    type(await field("Client secret"), "s3cret-value-1234");
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/sso", { issuer: "https://login.acme.example", clientId: "acme-app", clientSecret: "s3cret-value-1234", label: "Acme login", adminGroup: "", groupsClaim: "" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Sign-in provider saved", "success"));
    expect(await screen.findByText("Active")).toBeTruthy();
    expect(((await field("Client secret")) as HTMLInputElement).value).toBe("");
  });

  it("does not offer to save a new provider without its secret", async () => {
    render(<SingleSignOn />);

    type(await field("Issuer"), "https://login.acme.example");
    type(await field("Client ID"), "acme-app");

    expect((screen.getByRole("button", { name: "Save provider" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets a stored secret stay when only the button name changes, and asks for it again when the issuer changes", async () => {
    api.get.mockResolvedValue(SAVED);
    render(<SingleSignOn />);

    const secret = await field("Client secret");
    expect(secret.placeholder).toContain("ending in 1234");
    type(await field("Button name"), "Acme SSO");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("sso-issuer-changed")).toBeNull();

    type(await field("Issuer"), "https://elsewhere.example");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("sso-issuer-changed").textContent).toContain("ends sign-in for everyone who linked the old one");
    expect(screen.getByText("Enter the client secret to save.")).toBeTruthy();
  });

  it("sends a blank secret, as the server's word for keeping the stored one, when only the button name changed", async () => {
    api.get.mockResolvedValue(SAVED);
    api.put.mockResolvedValue({ ...SAVED, label: "Acme SSO" });
    render(<SingleSignOn />);

    type(await field("Button name"), "Acme SSO");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/sso", { issuer: SAVED.issuer, clientId: SAVED.clientId, clientSecret: "", label: "Acme SSO", adminGroup: "", groupsClaim: "" }));
  });

  it("asks for the secret again when the stored one cannot be read, even for the same issuer", async () => {
    api.get.mockResolvedValue({ ...SAVED, unreadable: true, active: false });
    render(<SingleSignOn />);

    expect(((await field("Client secret")) as HTMLInputElement).placeholder).toBe("");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    type(await field("Client secret"), "s3cret-value-1234");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says what the server refused, and keeps what was typed", async () => {
    api.put.mockRejectedValue(new Error("Could not read the provider's discovery document."));
    render(<SingleSignOn />);

    type(await field("Issuer"), "https://login.acme.example");
    type(await field("Client ID"), "acme-app");
    type(await field("Client secret"), "s3cret-value-1234");
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    expect((await screen.findByRole("alert")).textContent).toContain("discovery document");
    expect(((await field("Issuer")) as HTMLInputElement).value).toBe("https://login.acme.example");
    expect(toast).not.toHaveBeenCalled();
  });

  it("on Free says it is in Pro and the trial, keeps showing what was saved, and offers no form", async () => {
    api.get.mockResolvedValue({ ...SAVED, plan: "free", available: false, active: false });
    render(<SingleSignOn />);

    expect((await screen.findByTestId("sso-upgrade")).textContent).toMatch(/included in Pro and in the trial/);
    expect(screen.getByTestId("sso-upgrade").textContent).toMatch(/comes back with Pro/);
    expect(screen.getByText("Saved, not offered")).toBeTruthy();
    expect(screen.getByText("https://login.acme.example")).toBeTruthy();
    expect(screen.queryByTestId("sso-form")).toBeNull();
    expect(screen.queryByTestId("sso-redirect")).toBeNull();
  });

  it("lets a Free organisation take away what it stored, since removal has no plan", async () => {
    api.get.mockResolvedValue({ ...SAVED, plan: "free", available: false, active: false });
    api.del.mockResolvedValue({ ...PRO_EMPTY, plan: "free", available: false });
    render(<SingleSignOn />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);

    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/api/settings/sso"));
    expect(await screen.findByText("Not set up")).toBeTruthy();
  });

  it("on a trial says until when it is included", async () => {
    api.get.mockResolvedValue({ ...PRO_EMPTY, trial: true, trialEndsAt: "2026-11-09T21:59:59.000Z" });
    render(<SingleSignOn />);

    expect((await screen.findByTestId("sso-trial")).textContent).toContain("9 November 2026 (UTC)");
  });

  it("says a secret sealed under a key the server no longer has has to be entered again", async () => {
    api.get.mockResolvedValue({ ...SAVED, unreadable: true, active: false });
    render(<SingleSignOn />);

    expect((await screen.findByRole("alert")).textContent).toContain("cannot be read");
    expect(screen.getByText("Cannot be read")).toBeTruthy();
  });

  it("removes the provider after a confirmation that says how people then sign in", async () => {
    api.get.mockResolvedValue(SAVED);
    api.del.mockResolvedValue(PRO_EMPTY);
    render(<SingleSignOn />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.getByText(/use Forgot password to set a password/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);

    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/api/settings/sso"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Sign-in provider removed", "success"));
    // The dialog's buttons are not the form's: removing never saves
    expect(api.put).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is cancelled, and saves nothing either", async () => {
    api.get.mockResolvedValue(SAVED);
    render(<SingleSignOn />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(api.del).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("says where the provider is set when the instance is not the cloud", async () => {
    api.get.mockResolvedValue({ hosted: false });
    render(<SingleSignOn />);

    expect((await screen.findByTestId("sso-environment")).textContent).toContain("environment variables");
    expect(screen.queryByTestId("sso-form")).toBeNull();
  });

  it("says so when the answer cannot be read, and tries again", async () => {
    api.get.mockRejectedValueOnce(new Error("boom"));
    render(<SingleSignOn />);

    expect(await screen.findByTestId("sso-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await field("Issuer")).toBeTruthy();
  });
});

describe("Require single sign-on (BP-951)", () => {
  it("is not offered before a provider is set up and active", async () => {
    render(<SingleSignOn />);
    await field("Issuer");

    expect(screen.queryByTestId("sso-enforce-warning")).toBeNull();
  });

  it("warns that a wrong setup locks everybody out, and requires it with one click", async () => {
    api.get.mockResolvedValue(SAVED);
    api.put.mockResolvedValue({ ...SAVED, enforced: true });
    render(<SingleSignOn />);

    expect((await screen.findByTestId("sso-enforce-warning")).textContent).toContain("nobody can sign in");
    fireEvent.click(screen.getByRole("button", { name: "Require single sign-on" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/sso/enforce", { enforced: true }));
    expect(await screen.findByText("Required")).toBeTruthy();
  });

  it("says why when the server refuses it", async () => {
    api.get.mockResolvedValue(SAVED);
    api.put.mockRejectedValue(new Error("Set up your single sign-on provider first"));
    render(<SingleSignOn />);

    fireEvent.click(await screen.findByRole("button", { name: "Require single sign-on" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Set up your single sign-on provider first");
    expect(screen.queryByText("Required")).toBeNull();
  });

  it("stops requiring it with one click, since that is the way back", async () => {
    api.get.mockResolvedValue({ ...SAVED, enforced: true });
    api.put.mockResolvedValue({ ...SAVED, enforced: false });
    render(<SingleSignOn />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop requiring single sign-on" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/sso/enforce", { enforced: false }));
    expect(await screen.findByText("Not required")).toBeTruthy();
  });

  it("is not offered where the plan does not include the provider", async () => {
    api.get.mockResolvedValue({ ...SAVED, available: false, active: false, enforced: false });
    render(<SingleSignOn />);
    await screen.findByTestId("sso-upgrade");

    expect(screen.queryByTestId("sso-enforce-warning")).toBeNull();
  });
});

describe("Admin group (BP-951)", () => {
  it("says what the group does once one is typed, and sends it with the claim", async () => {
    api.get.mockResolvedValue(SAVED);
    api.put.mockResolvedValue({ ...SAVED, adminGroup: "acme-admins", groupsClaim: "roles" });
    render(<SingleSignOn />);

    expect(screen.queryByTestId("sso-admin-group-note")).toBeNull();
    type(await field("Admin group (optional)"), "acme-admins");
    type(await field("Groups claim (optional)"), "roles");
    expect(screen.getByTestId("sso-admin-group-note").textContent).toContain("everybody else a member");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/sso", expect.objectContaining({ adminGroup: "acme-admins", groupsClaim: "roles" })));
  });

  it("shows the stored group", async () => {
    api.get.mockResolvedValue({ ...SAVED, adminGroup: "acme-admins", groupsClaim: "roles" });
    render(<SingleSignOn />);

    expect(((await field("Admin group (optional)")) as HTMLInputElement).value).toBe("acme-admins");
    expect(((await field("Groups claim (optional)")) as HTMLInputElement).value).toBe("roles");
  });
});
