// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PmAgentSection } from "./PmAgentSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  // `get` reads today's PM spend on mount (BP-284). Rejecting rather than resolving keeps these
  // cases about what they were about: the section renders its settings whether or not the number
  // is available, which is the behaviour the catch beside the call exists for.
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

/** What the Save bar has been told: the newest registration's dirty-field count. */
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

    // BP-510: two servers put two buttons called "Test connection" on the card, and nothing in
    // either name said which server it would reach
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
    // Named per row since BP-510, so this asks for the name the admin case asserts is there
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

  // The positive half of the non-admin case above: these exist here, named per row, so that
  // `queryByLabelText("Remove jira") === null` there is a real absence and not a stale name
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

/**
 * BP-453. The cap counts from midnight in the board's own zone, so the hint has to name the zone
 * the SERVER will actually use — `turn-cap.ts` falls back when the stored one is unreadable, and a
 * truthiness check here would announce a zone nothing counts in.
 */
describe("the turn-cap hint", () => {
  // Cast because `timezone` is a required string on the type and the row this covers has none —
  // a document written before the field existed, which is exactly the case being asserted.
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

  // The legacy row `validatePmConfig` would refuse on write but which predates it. The server
  // counts in Europe/Warsaw for this board; the hint must not claim otherwise.
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

/**
 * BP-574. Disconnect committed the WHOLE live draft, and `useDraft.commit` moves the baseline as
 * well as the value — so every unsaved edit in the PM section was adopted as saved. Nothing had
 * been sent: the Save bar disappeared, the typed text stayed on screen looking saved, and Discard
 * could no longer rewind it because the baseline was now the edits.
 */
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

  /**
   * The other half, and the reason the broken line was written: the connection is already gone on
   * the server, so the status must not be a dirty edit Discard can undo.
   */
  it("does not itself make the form dirty", async () => {
    renderSection(true);
    api.post.mockResolvedValue({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect notion" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("OAuth connection removed", "success"));
    expect(dirtyCount()).toBe(0);
  });

  // The control: a refused disconnect changes nothing at all
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

/**
 * BP-574. The budget's de-duplication searched the unfiltered row list, so a disabled row sharing
 * an identity with an enabled one made the enabled row's contribution vanish — and with it the
 * flood warning, which is the whole point of the feature.
 */
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

  // The control: two ENABLED twins really do share one catalogue and must be counted once, which
  // is what the de-duplication was added for
  it("counts one catalogue once when two enabled rows share it", async () => {
    await warningAfterProbe(twins({ enabled: true }, { enabled: true }));

    await waitFor(() =>
      expect(screen.getByTestId("mcp-tool-budget-warning").textContent).toContain("45 MCP tools")
    );
  });
});

/**
 * The narrower window the first fix left open: a disconnect awaits a round trip, and the writes
 * that follow it must not rewind to the arrays captured when the button was clicked (BP-574
 * review).
 */
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

/**
 * The half of the behaviour `rebase` exists for, and which the dirty-count test alone cannot see:
 * the connection is destroyed server-side, so Discard must not put "Connected" back.
 */
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
    // The control: Connect is what an unconfigured row offers, so the row is still there
    expect(screen.getByRole("button", { name: "Connect notion" })).toBeTruthy();
  });
});
