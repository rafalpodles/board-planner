// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

function renderSection(isAdmin: boolean, over: Partial<ApiProject> = {}) {
  return render(
    <SettingsProvider register={vi.fn()} unregister={vi.fn()}>
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
