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
    expect(screen.getByText(/Anyone who signs in with Acme SSO or Google at one of these domains/)).toBeTruthy();
  });

  it("saves the list however it was separated, and shows what was stored", async () => {
    api.put.mockResolvedValue({ ...ANSWER, domains: ["corp.example", "lab.example"] });
    render(<SignUpDomains />);
    const input = (await screen.findByLabelText("Domains")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "corp.example,  lab.example Lab.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domains" }));

    await waitFor(() => expect(input.value).toBe("corp.example, lab.example"));
    expect(api.put).toHaveBeenCalledWith("/api/admin/sign-up", { domains: ["corp.example", "lab.example", "Lab.example"] });
    expect(toast).toHaveBeenCalledWith("Sign-up domains saved", "success");
  });

  it("says why a save was refused, and keeps what was typed", async () => {
    api.put.mockRejectedValue(new Error('"*.corp.example" is not a domain name'));
    render(<SignUpDomains />);
    const input = (await screen.findByLabelText("Domains")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "*.corp.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domains" }));

    expect((await screen.findByRole("alert")).textContent).toBe('"*.corp.example" is not a domain name');
    expect(input.value).toBe("*.corp.example");
  });

  it("says sign-up needs a provider that confirms addresses when there is none, and takes no domains", async () => {
    api.get.mockResolvedValue({ ...ANSWER, domains: [], providers: [] });
    render(<SignUpDomains />);

    expect(await screen.findByText(/Needs single sign-on or Google sign-in/)).toBeTruthy();
    expect((screen.getByLabelText("Domains") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save domains" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the admin group when one decides administrators", async () => {
    api.get.mockResolvedValue({ ...ANSWER, adminGroup: { group: "planner-admins", provider: "Acme SSO" } });
    render(<SignUpDomains />);

    expect(await screen.findByText(/Each sign-in with Acme SSO makes members of the group planner-admins administrators/)).toBeTruthy();
  });

  it("warns that a public mail service opens sign-up to anybody", async () => {
    api.get.mockResolvedValue({ ...ANSWER, domains: ["corp.example", "gmail.com"] });
    render(<SignUpDomains />);

    expect(await screen.findByText(/gmail.com looks like a public mail service: anybody with an address there could sign up/)).toBeTruthy();
  });

  it("warns about a public mail service as it is typed, before it is saved", async () => {
    render(<SignUpDomains />);
    const input = await screen.findByLabelText("Domains");

    fireEvent.change(input, { target: { value: "corp.example, @GMail.com" } });

    expect(screen.getByText(/gmail.com looks like a public mail service/)).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("gives no such warning for a company's own domain", async () => {
    render(<SignUpDomains />);
    await screen.findByLabelText("Domains");

    expect(screen.queryByText(/public mail/)).toBeNull();
  });

  it("still lets domains saved before the provider went be cleared", async () => {
    api.get.mockResolvedValue({ ...ANSWER, providers: [] });
    api.put.mockResolvedValue({ ...ANSWER, domains: [], providers: [] });
    render(<SignUpDomains />);
    const input = (await screen.findByLabelText("Domains")) as HTMLInputElement;

    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domains" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/admin/sign-up", { domains: [] }));
  });
});
