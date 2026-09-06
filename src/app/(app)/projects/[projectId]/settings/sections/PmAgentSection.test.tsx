// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PmAgentSection } from "./PmAgentSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { post: vi.fn(), put: vi.fn(), get: vi.fn(() => Promise.reject(new Error("not stubbed here"))) },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

function project(over: Partial<ApiProject> = {}): ApiProject {
  return {
    _id: "p1",
    key: "TP",
    name: "Test Project",
    description: "",
    icon: "",
    canAdmin: true,
    pmAvailable: true,
    pm: {
      enabled: true,
      model: "",
      contextNotes: "",
      links: [],
      dailyTurnCap: 0,
      mcpServers: [
        {
          name: "jira",
          url: "https://mcp.jira.example/mcp",
          authType: "bearer",
          allowWrites: false,
          toolAllowlist: [],
          enabled: true,
          hasAuthToken: true,
        },
        {
          name: "notion",
          url: "https://mcp.notion.example/mcp",
          authType: "oauth",
          allowWrites: false,
          toolAllowlist: [],
          enabled: true,
          hasAuthToken: false,
          oauthStatus: "connected",
          oauthClientId: "",
        },
      ],
    },
    ...over,
  } as ApiProject;
}

const register = vi.fn();

const dirtyCount = () => register.mock.calls.at(-1)?.[0]?.count;

function renderSection(isAdmin: boolean, over: Partial<ApiProject> = {}) {
  return render(
    <SettingsProvider register={register} unregister={vi.fn()}>
      <PmAgentSection
        projectId="p1"
        project={project(over)}
        patchProject={vi.fn()}
        replaceProject={vi.fn()}
        isAdmin={isAdmin}
        stats={null}
      />
    </SettingsProvider>
  );
}

beforeEach(() => {
  register.mockClear();
  api.post.mockReset();
  api.put.mockReset();
  toast.mockReset();
});
afterEach(cleanup);

describe("PmAgentSection MCP connections — owner (not instance admin)", () => {
  it("shows Connect, Reconnect, Disconnect and Test connection, one named per server", () => {
    renderSection(false);

    expect(screen.getByRole("button", { name: "Test connection for jira" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test connection for notion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect notion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect notion" })).toBeTruthy();
  });

  it("shows each server's name as read-only text instead of an editable field", () => {
    renderSection(false);

    expect(screen.getByText("jira")).toBeTruthy();
    expect(screen.getByText("notion")).toBeTruthy();
    expect(screen.queryByPlaceholderText("name (slug, e.g. notion)")).toBeNull();
  });

  it("hides the server-definition inputs and lifecycle controls", () => {
    renderSection(false);

    expect(screen.queryByPlaceholderText("https://mcp.example.com/mcp")).toBeNull();
    expect(screen.queryByPlaceholderText("Token set — leave empty to keep")).toBeNull();
    expect(screen.queryByPlaceholderText("Tool allowlist, comma-separated (empty = all)")).toBeNull();
    expect(screen.queryByLabelText("Enabled")).toBeNull();
    expect(screen.queryByLabelText("Allow writes")).toBeNull();
    expect(screen.queryByLabelText("Remove jira")).toBeNull();
    expect(screen.queryByLabelText(/^Remove /)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add MCP server" })).toBeNull();
  });
});

describe("PmAgentSection MCP connections — instance admin", () => {
  it("shows the server-definition inputs alongside Connect/Disconnect/Test", () => {
    renderSection(true);

    expect(screen.getByDisplayValue("jira")).toBeTruthy();
    expect(screen.getByDisplayValue("https://mcp.jira.example/mcp")).toBeTruthy();
    expect(screen.getByPlaceholderText("Token set — leave empty to keep")).toBeTruthy();
    expect(screen.getAllByPlaceholderText("Tool allowlist, comma-separated (empty = all)")).toHaveLength(2);
    expect(screen.getAllByLabelText("Enabled")).toHaveLength(2);
    expect(screen.getAllByLabelText("Allow writes")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Add MCP server" })).toBeTruthy();

    expect(screen.getByRole("button", { name: "Test connection for jira" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test connection for notion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect notion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect notion" })).toBeTruthy();
  });

  it("names each row's inputs and its remove button after that server", () => {
    renderSection(true);

    expect(screen.getByLabelText("Name for jira")).toBeTruthy();
    expect(screen.getByLabelText("URL for notion")).toBeTruthy();
    expect(screen.getByLabelText("Remove jira")).toBeTruthy();
    expect(screen.getByLabelText("Remove notion")).toBeTruthy();
  });
});

describe("PmAgentSection MCP connections — plain member (neither owner nor instance admin)", () => {
  it("renders nothing, since project.canAdmin gates the whole card", () => {
    renderSection(false, { canAdmin: false });

    expect(screen.queryByText("MCP connections")).toBeNull();
  });
});

describe("the turn-cap hint", () => {
  const withZone = (timezone: string | undefined) =>
    ({
      autonomy: {
        dailyReview: false,
        reviewHour: 9,
        reviewIntervalHours: 24,
        timezone,
        handleNeedsHumanReview: false,
        lastReviewSlot: "",
      },
    }) as unknown as Pick<NonNullable<ApiProject["pm"]>, "autonomy">;

  it("names the board's own zone", () => {
    renderSection(true, { pm: { ...project().pm!, ...withZone("Asia/Tokyo") } });

    expect(screen.getByText(/Resets at midnight in Asia\/Tokyo/)).toBeTruthy();
  });

  it("says a failed turn counts, which is the decision it exists to record", () => {
    renderSection(true, { pm: { ...project().pm!, ...withZone("Asia/Tokyo") } });

    expect(screen.getByText(/a turn the model failed/)).toBeTruthy();
  });

  it("names the fallback when the stored zone is one the server cannot read", () => {
    renderSection(true, { pm: { ...project().pm!, ...withZone("Warsaw") } });

    expect(screen.getByText(/Resets at midnight in Europe\/Warsaw/)).toBeTruthy();
    expect(screen.queryByText(/midnight in Warsaw\./)).toBeNull();
  });

  it("names the fallback when the board never stored one at all", () => {
    renderSection(true, { pm: { ...project().pm!, ...withZone(undefined) } });

    expect(screen.getByText(/Resets at midnight in Europe\/Warsaw/)).toBeTruthy();
  });
});

describe("disconnecting an OAuth server", () => {
  const notes = () => screen.getByLabelText(/Project context/i);

  it("leaves an unrelated unsaved edit dirty and still on screen", async () => {
    renderSection(true);
    api.post.mockResolvedValue({ ok: true });

    fireEvent.change(notes(), { target: { value: "something the admin typed" } });
    expect(dirtyCount()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect notion" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("OAuth connection removed", "success"));
    expect(dirtyCount()).toBe(1);
    expect((notes() as HTMLTextAreaElement).value).toBe("something the admin typed");
  });

  it("does not itself make the form dirty", async () => {
    renderSection(true);
    api.post.mockResolvedValue({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect notion" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("OAuth connection removed", "success"));
    expect(dirtyCount()).toBe(0);
  });

  it("leaves the row alone when the server refuses", async () => {
    renderSection(true);
    api.post.mockRejectedValue(new Error("nope"));

    fireEvent.change(notes(), { target: { value: "typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect notion" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("nope", "error"));
    expect(dirtyCount()).toBe(1);
    expect(screen.getByRole("button", { name: "Disconnect notion" })).toBeTruthy();
  });
});

describe("the flood warning's arithmetic", () => {
  const twins = (first: Partial<Record<string, unknown>>, second: Partial<Record<string, unknown>>) =>
    ({
      pm: {
        enabled: true,
        model: "",
        contextNotes: "",
        links: [],
        dailyTurnCap: 0,
        mcpServers: [
          {
            name: "notion",
            url: "https://mcp.notion.example/mcp",
            authType: "none",
            allowWrites: true,
            toolAllowlist: [],
            hasAuthToken: false,
            ...first,
          },
          {
            name: "notion",
            url: "https://mcp.notion.example/mcp",
            authType: "none",
            allowWrites: true,
            toolAllowlist: [],
            hasAuthToken: false,
            ...second,
          },
        ],
      },
    }) as unknown as Partial<ApiProject>;

  const tools = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `list_thing_${i}`, description: "d", readSafe: true }));

  async function warningAfterProbe(over: Partial<ApiProject>) {
    api.post.mockResolvedValue({ count: 45, tools: tools(45) });
    renderSection(true, over);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    return screen.queryByTestId("mcp-tool-budget-warning");
  }

  it("is not silenced by a disabled row that shares an enabled row's identity", async () => {
    const warning = await warningAfterProbe(twins({ enabled: false }, { enabled: true }));

    await waitFor(() => expect(screen.getByTestId("mcp-tool-budget-warning")).toBeTruthy());
    expect(warning ?? screen.getByTestId("mcp-tool-budget-warning")).toBeTruthy();
  });

  it("counts one catalogue once when two enabled rows share it", async () => {
    await warningAfterProbe(twins({ enabled: true }, { enabled: true }));

    await waitFor(() =>
      expect(screen.getByTestId("mcp-tool-budget-warning").textContent).toContain("45 MCP tools")
    );
  });
});

describe("editing while a disconnect is in flight", () => {
  it("keeps what was typed during the round trip", async () => {
    renderSection(true);
    let land: (value: unknown) => void = () => {};
    api.post.mockImplementation(() => new Promise((resolve) => (land = resolve)));

    fireEvent.click(screen.getByRole("button", { name: "Disconnect notion" }));
    fireEvent.change(screen.getByLabelText("Tool allowlist for jira"), {
      target: { value: "typed_during_the_flight" },
    });

    land({ ok: true });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("OAuth connection removed", "success"));

    expect((screen.getByLabelText("Tool allowlist for jira") as HTMLInputElement).value).toBe(
      "typed_during_the_flight"
    );
    expect(dirtyCount()).toBe(1);
  });
});

describe("Discard after a disconnect", () => {
  it("does not resurrect the connection", async () => {
    renderSection(true);
    api.post.mockResolvedValue({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect notion" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("OAuth connection removed", "success"));
    expect(screen.queryByRole("button", { name: "Disconnect notion" })).toBeNull();

    register.mock.calls.at(-1)?.[0]?.discard?.();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Disconnect notion" })).toBeNull()
    );
    expect(screen.getByRole("button", { name: "Connect notion" })).toBeTruthy();
  });
});

describe("the rows moving under a disconnect", () => {
  it("disconnects the row it was asked about, not whoever took its position", async () => {
    renderSection(true, {
      pm: {
        enabled: true,
        model: "",
        contextNotes: "",
        links: [],
        dailyTurnCap: 0,
        mcpServers: [
          { name: "spare", url: "https://a.example/mcp", authType: "none", allowWrites: false, toolAllowlist: [], enabled: true, hasAuthToken: false },
          { name: "notion", url: "https://n.example/mcp", authType: "oauth", allowWrites: false, toolAllowlist: [], enabled: true, hasAuthToken: false, oauthStatus: "connected", oauthClientId: "" },
          { name: "linear", url: "https://l.example/mcp", authType: "oauth", allowWrites: false, toolAllowlist: [], enabled: true, hasAuthToken: false, oauthStatus: "connected", oauthClientId: "" },
        ],
      },
    } as unknown as Partial<ApiProject>);

    let land: (value: unknown) => void = () => {};
    api.post.mockImplementation(() => new Promise((resolve) => (land = resolve)));

    fireEvent.click(screen.getByRole("button", { name: "Disconnect notion" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove spare" }));

    land({ ok: true });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("OAuth connection removed", "success"));

    expect(screen.queryByRole("button", { name: "Disconnect notion" })).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect linear" })).toBeTruthy();
  });

  it("does not roll back a save that landed during the round trip", async () => {
    renderSection(true);
    let landDisconnect: (value: unknown) => void = () => {};
    api.post.mockImplementation(() => new Promise((resolve) => (landDisconnect = resolve)));

    fireEvent.click(screen.getByRole("button", { name: "Disconnect notion" }));
    fireEvent.change(screen.getByLabelText(/Project context/i), { target: { value: "saved text" } });
    expect(dirtyCount()).toBe(1);

    api.put.mockResolvedValue({
      _id: "p1",
      key: "TP",
      name: "Test Project",
      canAdmin: true,
      pmAvailable: true,
      pm: { enabled: true, model: "", contextNotes: "saved text", links: [], dailyTurnCap: 0, mcpServers: [] },
    });
    await register.mock.calls.at(-1)![0].save();
    await waitFor(() => expect(dirtyCount()).toBe(0));

    landDisconnect({ ok: true });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("OAuth connection removed", "success"));

    expect(dirtyCount()).toBe(0);
  });
});
