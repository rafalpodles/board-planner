// @vitest-environment happy-dom
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject, ApiProjectMember } from "@/types";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";

const { api, toast, routerReplace } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: routerReplace }) }));

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

const register = vi.fn();
const accessGroup = () =>
  register.mock.calls.map(([group]) => group).filter((g) => g.id === "general-access").at(-1);

// BP-741: access is staged like the rest of the page, so every change here lands through Save
async function save() {
  await act(async () => {
    await accessGroup().save();
  });
}

const replaceProject = vi.fn();

function renderSection(as: { currentUserId?: string; isAdmin?: boolean } = {}) {
  return render(
    <SettingsProvider register={register} unregister={vi.fn()}>
      <GeneralSection
        projectId="p1"
        project={project()}
        patchProject={vi.fn()}
        replaceProject={replaceProject}
        isAdmin={as.isAdmin ?? false}
        currentUserId={as.currentUserId}
        stats={null}
      />
    </SettingsProvider>
  );
}

beforeEach(() => {
  register.mockReset();
  replaceProject.mockReset();
  routerReplace.mockReset();
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

  // Once the reader's own access changes they may own the board no more: the page saves it last
  it("asks to be saved after every other group", async () => {
    renderSection();
    await screen.findByLabelText("Access for bob");

    expect(accessGroup()?.saveLast).toBe(true);
  });

  it("writes nothing when access is changed, and counts it as an unsaved change", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() => expect(accessGroup()?.count).toBe(1));
    expect(select).toHaveProperty("value", "owner");
    expect(api.put).not.toHaveBeenCalled();
    expect(api.del).not.toHaveBeenCalled();
  });

  it("puts the row back on Discard", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for alice");

    fireEvent.change(select, { target: { value: "member" } });
    await waitFor(() => expect(accessGroup()?.count).toBe(1));
    act(() => accessGroup().discard());

    await waitFor(() => expect(select).toHaveProperty("value", "owner"));
    expect(accessGroup()?.count).toBe(0);
  });

  it("does not count a change put back by hand", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for alice");

    fireEvent.change(select, { target: { value: "member" } });
    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() => expect(accessGroup()?.count).toBe(0));
  });

  it("PUTs the chosen relation when access is granted or changed, not DELETE", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });
    await save();

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
    await save();

    await waitFor(() =>
      expect(api.del).toHaveBeenCalledWith("/api/projects/p1/members?userId=u1")
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("refreshes the member list and confirms success after a change lands", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });
    await save();

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
    await save();

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
    await save();

    await waitFor(() => expect(toast).toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error"));
    expect(select).toHaveProperty("value", "member");
    // And nobody else's relation moved with it
    expect(screen.getByLabelText("Access for bob")).toHaveProperty("value", "none");
  });

  /**
   * BP-592, a consequence of BP-583's own fix. The list is grant rows plus instance admins, so
   * `GET …/members` never answers with a non-admin holding no relation. Nulling the row left a
   * live access select on somebody the endpoint could not return — a row that cannot exist.
   */
  it("removes a revoked member's row when the list cannot be re-read", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for alice");
    api.get.mockRejectedValueOnce(new Error("network down"));

    fireEvent.change(select, { target: { value: "none" } });
    await save();

    await waitFor(() => expect(toast).toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error"));
    expect(screen.queryByLabelText("Access for alice")).toBeNull();
    // Only that row: without the id guard a revocation takes the whole list with it
    expect(screen.getByLabelText("Access for bob")).toBeTruthy();
  });

  /**
   * Why dropping the row is always right here: a `<select>` exists only on a row the endpoint built
   * from a grant. The label is keyed on `instanceAdmin` alone — *not* on holding no relation — so
   * an admin who also holds a grant is a label too, and no revocation on this screen can reach the
   * one kind of row the endpoint returns without a grant.
   */
  it("gives an instance admin a label whether or not they hold a grant", async () => {
    api.get.mockResolvedValue([
      ...members,
      { _id: "u4", username: "dan", fullName: "Dan D", relation: "owner", instanceAdmin: true },
    ]);
    renderSection();
    await screen.findByLabelText("Access for alice");

    expect(screen.queryByLabelText("Access for carol")).toBeNull();
    expect(screen.queryByLabelText("Access for dan")).toBeNull();
    expect(screen.getAllByText("Instance admin")).toHaveLength(2);
  });

  // The control: a write that genuinely fails must still be reported as the write's failure, and
  // must not claim the access was updated
  it("still reports a failed write as one, and does not confirm it", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");
    api.put.mockRejectedValueOnce(new Error("nope"));

    fireEvent.change(select, { target: { value: "owner" } });
    await save();

    await waitFor(() => expect(toast).toHaveBeenCalledWith("bob: nope", "error"));
    expect(toast).not.toHaveBeenCalledWith("Access updated", "success");
    expect(toast).not.toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error");
    // and it is still there to save again
    expect(select).toHaveProperty("value", "owner");
    expect(accessGroup()?.count).toBe(1);
  });

  // A write that failed must not be followed by the read at all: the list on screen is still true
  it("does not re-read the list after a write that failed", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    api.put.mockRejectedValueOnce(new Error("nope"));

    fireEvent.change(select, { target: { value: "owner" } });
    await save();

    await waitFor(() => expect(toast).toHaveBeenCalledWith("bob: nope", "error"));
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's last-owner conflict message instead of a generic failure", async () => {
    api.put.mockRejectedValueOnce(new Error("A board must keep at least one owner"));
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });
    await save();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("bob: A board must keep at least one owner", "error")
    );
    expect(toast).not.toHaveBeenCalledWith("Failed to update access", "error");
  });

  // Handing the board over in one save: were the demotion sent first, the server would refuse it
  // as the last owner stepping down
  it("grants ownership before it takes any away", async () => {
    renderSection();
    fireEvent.change(await screen.findByLabelText("Access for alice"), {
      target: { value: "member" },
    });
    fireEvent.change(screen.getByLabelText("Access for bob"), { target: { value: "owner" } });
    await waitFor(() => expect(accessGroup()?.count).toBe(2));

    await save();

    expect(api.put.mock.calls.map(([, body]) => body)).toEqual([
      { userId: "u2", relation: "owner" },
      { userId: "u1", relation: "member" },
    ]);
  });

  describe("the reader's own access", () => {
    // Alice owns the board with Dave. Were her step-down sent first, she would own it no more
    // and the removal behind it would be refused
    const board: ApiProjectMember[] = [
      { _id: "u1", username: "alice", fullName: "Alice A", relation: "owner", instanceAdmin: false },
      { _id: "u2", username: "bob", fullName: "", relation: "member", instanceAdmin: false },
      { _id: "u4", username: "dave", fullName: "Dave D", relation: "owner", instanceAdmin: false },
    ];

    beforeEach(() => {
      api.get.mockImplementation(async (url: string) =>
        url.endsWith("/members") ? board : { ...project(), canAdmin: false }
      );
    });

    it("is sent after everybody else's", async () => {
      renderSection({ currentUserId: "u1" });
      fireEvent.change(await screen.findByLabelText("Access for alice"), {
        target: { value: "member" },
      });
      fireEvent.change(screen.getByLabelText("Access for bob"), { target: { value: "none" } });
      await waitFor(() => expect(accessGroup()?.count).toBe(2));

      await save();

      expect(api.del).toHaveBeenCalledWith("/api/projects/p1/members?userId=u2");
      expect(api.del.mock.invocationCallOrder[0]).toBeLessThan(api.put.mock.invocationCallOrder[0]);
      expect(api.put).toHaveBeenCalledWith("/api/projects/p1/members", {
        userId: "u1",
        relation: "member",
      });
    });

    // Were it sent, the page would drop to a member's view and the refused change could not be
    // saved again from it
    it("is kept back when a change before it was refused", async () => {
      api.del.mockRejectedValueOnce(new Error("Internal server error"));
      renderSection({ currentUserId: "u1" });
      fireEvent.change(await screen.findByLabelText("Access for alice"), {
        target: { value: "member" },
      });
      fireEvent.change(screen.getByLabelText("Access for bob"), { target: { value: "none" } });
      await waitFor(() => expect(accessGroup()?.count).toBe(2));

      await save();

      expect(api.put).not.toHaveBeenCalled();
      expect(accessGroup()?.count).toBe(2);
      expect(toast.mock.calls[0][0]).toContain("bob: Internal server error");
      expect(toast.mock.calls[0][0]).toContain("Your own access was left as it is until the refused");
      expect(replaceProject).not.toHaveBeenCalled();
    });

    it("once stepped down, re-reads the board rather than the owners' members list", async () => {
      renderSection({ currentUserId: "u1" });
      fireEvent.change(await screen.findByLabelText("Access for alice"), {
        target: { value: "member" },
      });

      await save();

      expect(api.get).toHaveBeenLastCalledWith("/api/projects/p1");
      expect(replaceProject).toHaveBeenCalledWith(expect.objectContaining({ canAdmin: false }));
      expect(toast).not.toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error");
    });

    it("once removed, leaves the board", async () => {
      renderSection({ currentUserId: "u1" });
      fireEvent.change(await screen.findByLabelText("Access for alice"), {
        target: { value: "none" },
      });

      await save();

      expect(routerReplace).toHaveBeenCalledWith("/projects");
    });

    // An instance admin keeps the board whatever their own grant says
    it("keeps an instance admin where they are", async () => {
      renderSection({ currentUserId: "u1", isAdmin: true });
      fireEvent.change(await screen.findByLabelText("Access for alice"), {
        target: { value: "none" },
      });

      await save();

      expect(routerReplace).not.toHaveBeenCalled();
      expect(api.get).toHaveBeenLastCalledWith("/api/projects/p1/members");
    });
  });

  it("holds every access control still while a save is in flight", async () => {
    let answer: (value: unknown) => void = () => {};
    api.put.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderSection();
    const select = (await screen.findByLabelText("Access for bob")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "owner" } });
    await waitFor(() => expect(accessGroup()?.count).toBe(1));

    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = accessGroup().save();
    });

    await waitFor(() => expect(select.disabled).toBe(true));
    expect((screen.getByLabelText("Add person") as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      answer({ ok: true });
      await saving;
    });
    expect(select.disabled).toBe(false);
  });

  it("keeps a refused change pending while the others land", async () => {
    api.put.mockImplementation(async (_url: string, body: { userId: string }) => {
      if (body.userId === "u1") throw new Error("A board must keep at least one owner");
      return { ok: true };
    });
    renderSection();
    fireEvent.change(await screen.findByLabelText("Access for alice"), {
      target: { value: "member" },
    });
    fireEvent.change(screen.getByLabelText("Access for bob"), { target: { value: "owner" } });

    await save();

    await waitFor(() => expect(accessGroup()?.count).toBe(1));
    expect(screen.getByLabelText("Access for alice")).toHaveProperty("value", "member");
    expect(toast).toHaveBeenCalledWith("Alice A: A board must keep at least one owner", "error");
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

  it("choosing a candidate lists them as a member to be saved, and clears the search", async () => {
    mockCandidates([{ _id: "u9", username: "dee", fullName: "Dee D" }]);
    renderSection();
    const input = (await screen.findByLabelText("Add person")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "dee" } });
    fireEvent.click(await screen.findByRole("button", { name: "Dee D" }));

    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByLabelText("Access for dee")).toHaveProperty("value", "member");
    expect(accessGroup()?.count).toBe(1);
    expect(api.put).not.toHaveBeenCalled();

    await save();

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/members", {
      userId: "u9",
      relation: "member",
    });
  });

  it("grants through PUT, not DELETE, when a candidate is chosen", async () => {
    mockCandidates([{ _id: "u9", username: "dee", fullName: "Dee D" }]);
    renderSection();
    const input = await screen.findByLabelText("Add person");

    fireEvent.change(input, { target: { value: "dee" } });
    fireEvent.click(await screen.findByRole("button", { name: "Dee D" }));
    await waitFor(() => expect(accessGroup()?.count).toBe(1));
    await save();

    expect(api.put).toHaveBeenCalled();
    expect(api.del).not.toHaveBeenCalled();
  });

  it("offers nobody already on the list or already waiting to be added", async () => {
    mockCandidates([
      { _id: "u3", username: "carol", fullName: "Carol C" },
      { _id: "u9", username: "dee", fullName: "Dee D" },
    ]);
    renderSection();
    const input = await screen.findByLabelText("Add person");

    fireEvent.change(input, { target: { value: "ee" } });
    // The control: somebody who is neither is still offered
    expect(await screen.findByRole("button", { name: "Dee D" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Carol C" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dee D" }));
    await screen.findByLabelText("Access for dee");
    fireEvent.change(input, { target: { value: "ee" } });

    expect(await screen.findByText("Already on the list")).toBeTruthy();
  });

  it("drops somebody added but not yet saved on Discard", async () => {
    mockCandidates([{ _id: "u9", username: "dee", fullName: "Dee D" }]);
    renderSection();
    const input = await screen.findByLabelText("Add person");

    fireEvent.change(input, { target: { value: "dee" } });
    fireEvent.click(await screen.findByRole("button", { name: "Dee D" }));
    await screen.findByLabelText("Access for dee");

    act(() => accessGroup().discard());

    await waitFor(() => expect(screen.queryByLabelText("Access for dee")).toBeNull());
    expect(accessGroup()?.count).toBe(0);
  });

  it("drops somebody added but not yet saved when set back to No access", async () => {
    mockCandidates([{ _id: "u9", username: "dee", fullName: "Dee D" }]);
    renderSection();
    const input = await screen.findByLabelText("Add person");

    fireEvent.change(input, { target: { value: "dee" } });
    fireEvent.click(await screen.findByRole("button", { name: "Dee D" }));
    fireEvent.change(await screen.findByLabelText("Access for dee"), { target: { value: "none" } });

    await waitFor(() => expect(screen.queryByLabelText("Access for dee")).toBeNull());
    expect(accessGroup()?.count).toBe(0);
  });
});

// BP-784: an answer that arrives after a later read, or after a change the page made itself, used
// to put the older list back
describe("GeneralSection members read", () => {
  function held() {
    let resolve!: (rows: ApiProjectMember[]) => void;
    const promise = new Promise<ApiProjectMember[]>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const aliceAs = (relation: "owner" | "member") => [{ ...members[0], relation }, ...members.slice(1)];

  it("keeps the second mount's list when the first mount's read answers last", async () => {
    const first = held();
    api.get.mockReset();
    api.get.mockReturnValueOnce(first.promise).mockResolvedValueOnce(members);

    render(
      <StrictMode>
        <SettingsProvider register={register} unregister={vi.fn()}>
          <GeneralSection
            projectId="p1"
            project={project()}
            patchProject={vi.fn()}
            replaceProject={replaceProject}
            isAdmin={false}
            stats={null}
          />
        </SettingsProvider>
      </StrictMode>
    );
    expect(await screen.findByLabelText("Access for alice")).toHaveProperty("value", "owner");

    await act(async () => first.resolve(aliceAs("member")));

    expect(screen.getByLabelText("Access for alice")).toHaveProperty("value", "owner");
  });

  it("keeps the newest re-read when an older one answers after it", async () => {
    const olderRefresh = held();
    api.get.mockReset();
    api.get
      .mockResolvedValueOnce(members)
      .mockReturnValueOnce(olderRefresh.promise)
      .mockResolvedValueOnce(aliceAs("member"));
    renderSection();
    const alice = await screen.findByLabelText("Access for alice");

    // First save: its re-read is held
    fireEvent.change(screen.getByLabelText("Access for bob"), { target: { value: "member" } });
    await act(async () => {
      void accessGroup().save();
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    // Second save lands and its re-read answers
    fireEvent.change(alice, { target: { value: "member" } });
    await save();
    await waitFor(() => expect(alice).toHaveProperty("value", "member"));

    await act(async () => olderRefresh.resolve(members));

    expect(screen.getByLabelText("Access for alice")).toHaveProperty("value", "member");
  });

  // Review: a slow first read landing between two writes of one save put the list back to before
  // the first, and with the re-read failing it stayed that way
  it("keeps a change that landed after the first read went out, even when the re-read fails", async () => {
    const first = held();
    api.get.mockReset();
    api.get.mockImplementation((url: string) => {
      if (url.includes("/members/candidates")) {
        return Promise.resolve([
          { _id: "u8", username: "dee", fullName: "Dee D" },
          { _id: "u9", username: "eve", fullName: "Eve E" },
        ]);
      }
      return api.get.mock.calls.filter(([u]) => !String(u).includes("candidates")).length === 1
        ? first.promise
        : Promise.reject(new Error("offline"));
    });
    api.put.mockImplementation(async (_url: string, body: { userId: string }) => {
      // The first read answers between the two grants: after Dee's landed, before Eve's
      if (body.userId === "u9") await act(async () => first.resolve(members));
      return { ok: true };
    });
    renderSection();
    const input = await screen.findByLabelText("Add person");
    for (const name of ["Dee D", "Eve E"]) {
      fireEvent.change(input, { target: { value: name.slice(0, 3).toLowerCase() } });
      fireEvent.click(await screen.findByRole("button", { name }));
    }

    await save();

    expect(screen.getByLabelText("Access for dee")).toHaveProperty("value", "member");
    expect(screen.getByLabelText("Access for eve")).toHaveProperty("value", "member");
    expect(toast).toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error");
  });
});
