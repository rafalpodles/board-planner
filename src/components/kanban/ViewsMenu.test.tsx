// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { ViewsMenu, ViewSnapshot } from "./ViewsMenu";
import type { ApiSavedView } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const view = (over: Partial<ApiSavedView> = {}): ApiSavedView => ({
  _id: "v1",
  name: "Mine",
  shared: false,
  mine: true,
  canEdit: true,
  filters: {},
  search: "",
  sortField: "manual",
  sortDir: "asc",
  viewMode: "board",
  groupBy: "",
  sprintScope: "all",
  hiddenColumns: [],
  ...over,
});

const snapshot: ViewSnapshot = {
  filters: { priority: "high" },
  search: "login",
  sortField: "title",
  sortDir: "desc",
  viewMode: "list",
  groupBy: "status",
  sprintScope: "backlog",
  hiddenColumns: ["category"],
};

function renderMenu(over: Partial<React.ComponentProps<typeof ViewsMenu>> = {}) {
  const onApply = vi.fn();
  render(
    <ViewsMenu projectId="p1" projectRef="TP" canShare={false} snapshot={() => snapshot} onApply={onApply} {...over} />
  );
  return { onApply };
}

async function open(views: ApiSavedView[] = []) {
  api.get.mockResolvedValue(views);
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  await screen.findByRole("dialog", { name: "Views" });
  if (views.length) await screen.findByText(views[0].name);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({});
  api.put.mockResolvedValue({});
  api.del.mockResolvedValue({});
});
afterEach(cleanup);

describe("ViewsMenu", () => {
  it("loads the views when it opens, says which are shared, and says so when there are none", async () => {
    renderMenu();
    await open([]);
    expect(await screen.findByText(/No saved views yet/)).toBeTruthy();
    cleanup();

    renderMenu();
    await open([view(), view({ _id: "v2", name: "Team", shared: true, canEdit: false, mine: false })]);
    const rows = screen.getAllByTestId("saved-view");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText("Shared")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/projects/p1/views");
  });

  it("hands the view to the board and closes when one is picked", async () => {
    const { onApply } = renderMenu();
    await open([view()]);

    fireEvent.click(screen.getByRole("button", { name: "Mine" }));

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ _id: "v1" }));
    expect(screen.queryByRole("dialog", { name: "Views" })).toBeNull();
  });

  it("offers each person only what they may do with a view", async () => {
    renderMenu({ canShare: false });
    await open([
      view(),
      view({ _id: "v2", name: "Team", shared: true, canEdit: false, mine: false }),
    ]);
    const [mine, team] = screen.getAllByTestId("saved-view");

    expect(within(mine).getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(within(mine).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(within(mine).queryByRole("button", { name: "Share" })).toBeNull();
    expect(within(mine).queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(within(team).getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(within(team).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(team).queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("lets only the person who made a view share or unshare it, whoever may delete it", async () => {
    renderMenu({ canShare: true });
    await open([view({ _id: "v3", name: "Theirs", shared: true, canEdit: true, mine: false })]);
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop sharing" })).toBeNull();
    cleanup();

    renderMenu({ canShare: true });
    await open([view({ _id: "v4", name: "Mine too" })]);
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  describe("saving", () => {
    it("sends the whole snapshot, without the search text unless it is ticked", async () => {
      renderMenu();
      await open();
      fireEvent.change(screen.getByLabelText("View name"), { target: { value: "My cut" } });
      fireEvent.click(screen.getByRole("button", { name: "Save view" }));

      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
      expect(api.post).toHaveBeenLastCalledWith("/api/projects/p1/views", {
        name: "My cut",
        shared: false,
        ...snapshot,
        search: "",
      });
    });

    it("keeps the search text when asked to, and offers sharing only to somebody who may", async () => {
      renderMenu({ canShare: true });
      await open();
      fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Team cut" } });
      fireEvent.click(screen.getByLabelText("Include the search text"));
      fireEvent.click(screen.getByLabelText("Share with everyone on this board"));
      fireEvent.click(screen.getByRole("button", { name: "Save view" }));

      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
      expect(api.post.mock.calls[0][1]).toMatchObject({ shared: true, search: "login" });
    });

    it("does not offer sharing to a member, and never sends it", async () => {
      renderMenu({ canShare: false });
      await open();
      expect(screen.queryByLabelText("Share with everyone on this board")).toBeNull();
      fireEvent.change(screen.getByLabelText("View name"), { target: { value: "x" } });
      fireEvent.click(screen.getByRole("button", { name: "Save view" }));

      await waitFor(() => expect(api.post).toHaveBeenCalled());
      expect(api.post.mock.calls[0][1].shared).toBe(false);
    });

    it("will not save with no name", async () => {
      renderMenu();
      await open();
      expect((screen.getByRole("button", { name: "Save view" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows the server's refusal and keeps the name for another try", async () => {
      api.post.mockRejectedValue(new Error("A view with this name already exists"));
      renderMenu();
      await open();
      fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Taken" } });
      fireEvent.click(screen.getByRole("button", { name: "Save view" }));

      expect((await screen.findByRole("alert")).textContent).toContain("already exists");
      expect((screen.getByLabelText("View name") as HTMLInputElement).value).toBe("Taken");
    });

    it("reads the list again after a save", async () => {
      renderMenu();
      await open();
      fireEvent.change(screen.getByLabelText("View name"), { target: { value: "x" } });
      fireEvent.click(screen.getByRole("button", { name: "Save view" }));

      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    });
  });

  it("renames, updates to what is on screen, shares and deletes through their own writes", async () => {
    renderMenu({ canShare: true });
    await open([view()]);

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name for Mine"), { target: { value: "Better" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith("/api/projects/p1/views", { viewId: "v1", name: "Better" }));

    fireEvent.click(screen.getByRole("button", { name: "Update to current" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenLastCalledWith("/api/projects/p1/views", { viewId: "v1", ...snapshot })
    );

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith("/api/projects/p1/views", { viewId: "v1", shared: true }));

  });

  it("asks before it deletes, and deletes only on the answer", async () => {
    renderMenu();
    await open([view()]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete view" });
    expect(dialog.textContent).toContain('Delete "Mine"?');
    expect(api.del).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/api/projects/p1/views", { viewId: "v1" }));
  });

  it("copies the link to a shared view", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderMenu();
    await open([view({ shared: true })]);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/projects/TP?view=v1`));
  });

  it("says when the list could not be loaded and tries again", async () => {
    api.get.mockRejectedValueOnce(new Error("down")).mockResolvedValue([view()]);
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Views" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Mine")).toBeTruthy();
  });

  it("closes on Escape with the focus back on its button, without the board hearing the key", async () => {
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    renderMenu();
    await open();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Views" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Views" }));
    expect(heard).not.toHaveBeenCalled();
    document.removeEventListener("keydown", heard);
  });

  it("moves the focus into the panel when it opens", async () => {
    renderMenu();
    await open();
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Views" }));
  });

  it("closes when the focus leaves it for something else, and not when it moves inside it", async () => {
    renderMenu();
    await open();
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    fireEvent.blur(screen.getByLabelText("View name"), { relatedTarget: screen.getByLabelText("Include the search text") });
    expect(screen.getByRole("dialog", { name: "Views" })).toBeTruthy();

    fireEvent.blur(screen.getByLabelText("View name"), { relatedTarget: outside });
    expect(screen.queryByRole("dialog", { name: "Views" })).toBeNull();
    outside.remove();
  });

  it("puts the focus back on its button after a view is picked", async () => {
    renderMenu();
    await open([view()]);

    fireEvent.click(screen.getByRole("button", { name: "Mine" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Views" }));
  });

  it("cancels a rename on Escape before it closes the menu", async () => {
    renderMenu();
    await open([view()]);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByLabelText("New name for Mine")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByLabelText("New name for Mine")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Views" })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Views" })).toBeNull();
  });

  it("leaves Escape to the delete confirmation while it is open, and keeps the menu", async () => {
    renderMenu();
    await open([view()]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "Delete view" });

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Views" })).toBeTruthy();
  });

  it("reads the list again when a write is refused, so a view that is gone leaves it", async () => {
    api.put.mockRejectedValue(new Error("View not found"));
    renderMenu();
    await open([view()]);
    api.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Update to current" }));

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("alert")).textContent).toContain("View not found");
  });

  it("keeps the newer list when an older answer arrives late", async () => {
    let releaseFirst: (v: ApiSavedView[]) => void = () => {};
    api.get.mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)));
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    await screen.findByRole("dialog", { name: "Views" });

    api.get.mockResolvedValue([view({ name: "Fresh" })]);
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await screen.findByText("Fresh");

    releaseFirst([view({ name: "Stale" })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.getByText("Fresh")).toBeTruthy();
  });

  it("sends one delete however often the confirmation is pressed", async () => {
    let finish: () => void = () => {};
    api.del.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    renderMenu();
    await open([view()]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete view" });
    const confirm = within(dialog).getByRole("button", { name: /^Delete$/ });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(api.del).toHaveBeenCalledTimes(1);
    finish();
  });

  it("closes on a click outside, and not on one inside", async () => {
    renderMenu();
    await open();

    fireEvent.mouseDown(screen.getByLabelText("View name"));
    expect(screen.getByRole("dialog", { name: "Views" })).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Views" })).toBeNull();
  });
});
