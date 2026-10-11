// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { YourData } from "./YourData";

const { api, logout, assign } = vi.hoisted(() => ({
  api: { del: vi.fn() },
  logout: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ logout }) }));

beforeEach(() => {
  vi.clearAllMocks();
  logout.mockResolvedValue(null);
  vi.stubGlobal("location", { assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = () => fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
const confirm = () => screen.getAllByRole("button", { name: "Delete my account" }).at(-1)!;

describe("Your data on Profile", () => {
  it("offers nothing destructive until asked, and asks for the password before it will delete", async () => {
    render(<YourData asksPassword />);
    expect(screen.queryByRole("dialog")).toBeNull();

    open();

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect((confirm() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct horse" } });
    expect((confirm() as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the password, then signs out and leaves for the sign-in", async () => {
    api.del.mockResolvedValue({ ok: true });
    render(<YourData asksPassword />);
    open();
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "correct horse" } });

    fireEvent.click(confirm());

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(api.del).toHaveBeenCalledWith("/api/users/me", { currentPassword: "correct horse" });
    expect(logout).toHaveBeenCalled();
  });

  it("goes to the sign-in address the server names when there is one", async () => {
    api.del.mockResolvedValue({ ok: true });
    logout.mockResolvedValue("https://login.example.com");
    render(<YourData asksPassword={false} />);
    open();

    fireEvent.click(confirm());

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://login.example.com"));
  });

  it("asks for no password where the account has none, and says a recent sign-in is needed", async () => {
    render(<YourData asksPassword={false} />);
    open();

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.getByText(/signed in within the last 10 minutes/)).toBeTruthy();
    expect((confirm() as HTMLButtonElement).disabled).toBe(false);
    expect(api.del).not.toHaveBeenCalled();
  });

  it("shows the server's reason and stays signed in when the deletion is refused", async () => {
    api.del.mockRejectedValue(new Error("You are the only owner of Alpha (AL). Make someone else an owner there before deleting your account."));
    render(<YourData asksPassword />);
    open();
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "correct horse" } });

    fireEvent.click(confirm());

    expect((await screen.findByRole("alert")).textContent).toContain("only owner of Alpha");
    expect(logout).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
