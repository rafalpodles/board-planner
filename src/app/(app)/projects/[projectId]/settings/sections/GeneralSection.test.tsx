// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject, ApiProjectMember } from "@/types";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

function project(over: Partial<ApiProject> = {}): ApiProject {
  return {
    _id: "p1",
    key: "TP",
    name: "Test Project",
    description: "",
    icon: "",
    canAdmin: true,
    ...over,
  } as ApiProject;
}

const members: ApiProjectMember[] = [
  { _id: "u1", username: "alice", fullName: "Alice A", relation: "owner", instanceAdmin: false },
  { _id: "u2", username: "bob", fullName: "", relation: null, instanceAdmin: false },
  { _id: "u3", username: "carol", fullName: "Carol C", relation: null, instanceAdmin: true },
];

function renderSection() {
  return render(
    <SettingsProvider register={vi.fn()} unregister={vi.fn()}>
      <GeneralSection
        projectId="p1"
        project={project()}
        patchProject={vi.fn()}
        replaceProject={vi.fn()}
        isAdmin={false}
        stats={null}
      />
    </SettingsProvider>
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  api.del.mockReset();
  toast.mockReset();
  api.get.mockResolvedValue(members);
  api.put.mockResolvedValue({ ok: true });
  api.del.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("GeneralSection member access", () => {
  it("shows each member's current relation, defaulting an ungranted member to No access", async () => {
    renderSection();

    expect(await screen.findByLabelText("Access for alice")).toHaveProperty("value", "owner");
    expect(screen.getByLabelText("Access for bob")).toHaveProperty("value", "none");
  });

  it("lists an instance admin for reference instead of a select", async () => {
    renderSection();
    await screen.findByLabelText("Access for alice");

    expect(screen.getByText("Instance admin")).toBeTruthy();
    expect(screen.queryByLabelText("Access for carol")).toBeNull();
  });

  it("PUTs the chosen relation when access is granted or changed, not DELETE", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/projects/p1/members", {
        userId: "u2",
        relation: "owner",
      })
    );
    expect(api.del).not.toHaveBeenCalled();
  });

  it("DELETEs the grant when access is revoked, not PUT", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for alice");

    fireEvent.change(select, { target: { value: "none" } });

    await waitFor(() =>
      expect(api.del).toHaveBeenCalledWith("/api/projects/p1/members?userId=u1")
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("refreshes the member list and confirms success after a change lands", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(toast).toHaveBeenCalledWith("Access updated", "success");
  });

  /**
   * BP-583. The grant and the list read after it were one `try`, so a blipped members GET told an
   * admin "Failed to update access" over access the server had already changed — and the row still
   * showed the old relation, so the obvious next move was to grant it again.
   */
  it("reports the refresh, not the write, when only the members read fails", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");
    api.get.mockRejectedValueOnce(new Error("network down"));

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() => expect(toast).toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error"));
    expect(toast).toHaveBeenCalledWith("Access updated", "success");
    expect(toast).not.toHaveBeenCalledWith("Failed to update access", "error");
  });

  // The harm the ticket names, and the half the message alone does not fix: with the list unread,
  // the row would fall back to the relation that was replaced and the toasts would expire over it
  it("leaves the row showing the change even when the list cannot be re-read", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for alice");
    api.get.mockRejectedValueOnce(new Error("network down"));

    fireEvent.change(select, { target: { value: "member" } });

    await waitFor(() => expect(toast).toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error"));
    expect(select).toHaveProperty("value", "member");
  });

  // The control: a write that genuinely fails must still be reported as the write's failure, and
  // must not claim the access was updated
  it("still reports a failed write as one, and does not confirm it", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");
    api.put.mockRejectedValueOnce(new Error("nope"));

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() => expect(toast).toHaveBeenCalledWith("nope", "error"));
    expect(toast).not.toHaveBeenCalledWith("Access updated", "success");
    expect(toast).not.toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error");
  });

  // A write that failed must not be followed by the read at all: the list on screen is still true
  it("does not re-read the list after a write that failed", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    api.put.mockRejectedValueOnce(new Error("nope"));

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() => expect(toast).toHaveBeenCalledWith("nope", "error"));
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's last-owner conflict message instead of a generic failure", async () => {
    api.put.mockRejectedValueOnce(new Error("A board must keep at least one owner"));
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("A board must keep at least one owner", "error")
    );
    expect(toast).not.toHaveBeenCalledWith("Failed to update access", "error");
  });
});

function mockCandidates(list: unknown[]) {
  api.get.mockImplementation((url: string) =>
    Promise.resolve(url.includes("/members/candidates") ? list : members)
  );
}

describe("GeneralSection add person", () => {
  it("shows nothing below 2 characters, not a dropdown or a query to the server", async () => {
    renderSection();
    const input = await screen.findByLabelText("Add person");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.change(input, { target: { value: "a" } });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.queryByText("No matches")).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("queries the candidates endpoint for the trimmed query and lists results", async () => {
    mockCandidates([{ _id: "u9", username: "dee", fullName: "Dee D" }]);
    renderSection();
    const input = await screen.findByLabelText("Add person");

    fireEvent.change(input, { target: { value: "  dee  " } });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/api/projects/p1/members/candidates?q=dee")
    );
    expect(await screen.findByText("Dee D")).toBeTruthy();
  });

  it("says no matches rather than nothing when a 2+ character query finds nobody", async () => {
    mockCandidates([]);
    renderSection();
    const input = await screen.findByLabelText("Add person");

    fireEvent.change(input, { target: { value: "zz" } });

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No matches")).toBeTruthy();
  });

  it("choosing a candidate grants member access, refreshes the list, and clears the search", async () => {
    mockCandidates([{ _id: "u9", username: "dee", fullName: "Dee D" }]);
    renderSection();
    const input = (await screen.findByLabelText("Add person")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "dee" } });
    const candidate = await screen.findByText("Dee D");
    fireEvent.click(candidate);

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/projects/p1/members", {
        userId: "u9",
        relation: "member",
      })
    );
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.queryByText("Dee D")).toBeNull();
  });

  it("grants through PUT, not DELETE, when a candidate is chosen", async () => {
    mockCandidates([{ _id: "u9", username: "dee", fullName: "Dee D" }]);
    renderSection();
    const input = await screen.findByLabelText("Add person");

    fireEvent.change(input, { target: { value: "dee" } });
    fireEvent.click(await screen.findByText("Dee D"));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.del).not.toHaveBeenCalled();
  });
});
