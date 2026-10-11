// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { BoardGroupRoles } from "./BoardGroupRoles";

const { api, toast } = vi.hoisted(() => ({ api: { get: vi.fn(), put: vi.fn() }, toast: vi.fn() }));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ map: [], hasProvider: true });
});
afterEach(cleanup);

describe("Roles from identity provider groups (BP-862)", () => {
  it("is left out where there is no provider and nothing is mapped", async () => {
    api.get.mockResolvedValue({ map: [], hasProvider: false });
    const { container } = render(<BoardGroupRoles projectId="p1" />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("is still shown with no provider when something is mapped, so it can be taken away", async () => {
    api.get.mockResolvedValue({ map: [{ group: "staff", role: "member" }], hasProvider: false });
    render(<BoardGroupRoles projectId="p1" />);

    expect(await screen.findByDisplayValue("staff")).toBeTruthy();
  });

  it("adds a group with a role and saves the whole list", async () => {
    api.put.mockResolvedValue({ map: [{ group: "leads", role: "owner" }], hasProvider: true });
    render(<BoardGroupRoles projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a group" }));
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: " leads " } });
    fireEvent.change(screen.getByLabelText(/^Role for/), { target: { value: "owner" } });
    fireEvent.click(screen.getByRole("button", { name: "Save group mapping" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/projects/p1/group-roles", { map: [{ group: "leads", role: "owner" }] }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Group mapping saved", "success"));
  });

  it("offers to save only a change, and only a complete one", async () => {
    render(<BoardGroupRoles projectId="p1" />);
    const save = await screen.findByRole("button", { name: "Save group mapping" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Add a group" }));
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: "staff" } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes a row", async () => {
    api.get.mockResolvedValue({ map: [{ group: "staff", role: "member" }], hasProvider: true });
    api.put.mockResolvedValue({ map: [], hasProvider: true });
    render(<BoardGroupRoles projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove staff" }));
    fireEvent.click(screen.getByRole("button", { name: "Save group mapping" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/projects/p1/group-roles", { map: [] }));
  });

  it("says why when the server refuses", async () => {
    api.get.mockResolvedValue({ map: [{ group: "staff", role: "member" }], hasProvider: true });
    api.put.mockRejectedValue(new Error("Your plan does not include this"));
    render(<BoardGroupRoles projectId="p1" />);

    fireEvent.change(await screen.findByLabelText("Group"), { target: { value: "staffers" } });
    fireEvent.click(screen.getByRole("button", { name: "Save group mapping" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Your plan does not include this");
  });

  it("says so when the mapping cannot be read, and tries again", async () => {
    api.get.mockRejectedValueOnce(new Error("boom"));
    render(<BoardGroupRoles projectId="p1" />);

    expect(await screen.findByTestId("group-roles-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByRole("button", { name: "Add a group" })).toBeTruthy();
  });
});
