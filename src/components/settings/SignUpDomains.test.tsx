// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SignUpDomains } from "./SignUpDomains";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const ANSWER = { domains: ["corp.example"], providers: ["Acme SSO", "Google"], adminGroup: null };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(ANSWER);
});
afterEach(cleanup);

describe("sign-up by domain", () => {
  it("shows the stored domains and which providers can open them", async () => {
    render(<SignUpDomains />);

    expect(((await screen.findByLabelText("Domains")) as HTMLInputElement).value).toBe("corp.example");
    expect(screen.getByText(/Anyone Acme SSO or Google confirms/)).toBeTruthy();
  });

  it("saves the list however it was separated, and shows what was stored", async () => {
    api.put.mockResolvedValue({ ...ANSWER, domains: ["corp.example", "lab.example"] });
    render(<SignUpDomains />);
    const input = (await screen.findByLabelText("Domains")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "corp.example,  lab.example Lab.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(input.value).toBe("corp.example, lab.example"));
    expect(api.put).toHaveBeenCalledWith("/api/admin/sign-up", { domains: ["corp.example", "lab.example", "Lab.example"] });
    expect(toast).toHaveBeenCalledWith("Sign-up domains saved", "success");
  });

  it("says why a save was refused, and keeps what was typed", async () => {
    api.put.mockRejectedValue(new Error('"*.corp.example" is not a domain name'));
    render(<SignUpDomains />);
    const input = (await screen.findByLabelText("Domains")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "*.corp.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe('"*.corp.example" is not a domain name');
    expect(input.value).toBe("*.corp.example");
  });

  it("says sign-up needs a provider that confirms addresses when there is none", async () => {
    api.get.mockResolvedValue({ ...ANSWER, providers: [] });
    render(<SignUpDomains />);

    expect(await screen.findByText(/Needs single sign-on or Google sign-in/)).toBeTruthy();
  });

  it("names the admin group when one decides administrators", async () => {
    api.get.mockResolvedValue({ ...ANSWER, adminGroup: "planner-admins" });
    render(<SignUpDomains />);

    expect(await screen.findByText(/Group planner-admins decides who is an administrator/)).toBeTruthy();
  });
});
