// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
const dialog = () => screen.getByRole("dialog");
const confirm = () => within(dialog()).getByRole("button", { name: "Delete my account" }) as HTMLButtonElement;

describe("deleting from Your data", () => {
  it("offers nothing destructive until asked, and asks for the password before it will delete", async () => {
    render(<YourData asksPassword />);
    expect(screen.queryByRole("dialog")).toBeNull();

    open();

    await screen.findByRole("dialog");
    expect(confirm().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct horse" } });
    expect(confirm().disabled).toBe(false);
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

  it("submits from the keyboard, as a form does, and not before there is a password", async () => {
    api.del.mockResolvedValue({ ok: true });
    render(<YourData asksPassword />);
    open();
    const field = await screen.findByLabelText("Current password");

    fireEvent.submit(field.closest("form")!);
    expect(api.del).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "correct horse" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(api.del).toHaveBeenCalledTimes(1));
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

    await screen.findByRole("dialog");
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.getByText(/signed in within the last 10 minutes/)).toBeTruthy();
    expect(confirm().disabled).toBe(false);
    expect(api.del).not.toHaveBeenCalled();
  });

  it("shows the server's reason, stays signed in and lets the person try again when it is refused", async () => {
    api.del.mockRejectedValue(new Error("You are the only owner of Alpha (AL). Make someone else an owner there before deleting your account."));
    render(<YourData asksPassword />);
    open();
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "correct horse" } });

    fireEvent.click(confirm());

    expect((await screen.findByRole("alert")).textContent).toContain("only owner of Alpha");
    expect(logout).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(confirm().disabled).toBe(false));
    expect(confirm().textContent).toBe("Delete my account");
  });

  it("is not left on Deleting… when cancelled after a refusal, and starts clean when reopened", async () => {
    api.del.mockRejectedValue(new Error("Current password is incorrect"));
    render(<YourData asksPassword />);
    open();
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "nope" } });
    fireEvent.click(confirm());
    await screen.findByRole("alert");

    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    open();

    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });
});

describe("downloading from Your data", () => {
  const click = () => fireEvent.click(screen.getByRole("button", { name: "Download my data" }));

  it("says why when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This action requires an interactive session" }), { status: 403 })));
    render(<YourData asksPassword />);

    click();

    expect((await screen.findByRole("alert")).textContent).toBe("This action requires an interactive session");
  });

  it("says so when the request cannot be made at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<YourData asksPassword />);

    click();

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be downloaded/);
  });

  it("is ready to be asked again after a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    render(<YourData asksPassword />);

    click();
    await screen.findByRole("alert");

    await waitFor(() => expect((screen.getByRole("button", { name: "Download my data" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
