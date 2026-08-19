// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { WorkersSection } from "./WorkersSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn() },
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
    repositoryUrl: "git@github.com:rafalpodles/board-planner.git",
    worker: {
      enabled: false,
      agent: null,
      policy: {
        autoMerge: false,
        reviewGate: true,
        baseBranch: "main",
        taskTimeoutMs: 1_800_000,
        runCeilingMs: 5_400_000,
        maxDiffLines: 400,
        maxDiffFiles: 10,
        model: "opus",
        fallbackModel: "sonnet",
        reviewModel: "opus",
      },
      policyOverrides: [],
    },
    ...over,
  } as ApiProject;
}

function renderSection(isAdmin: boolean, over: Partial<ApiProject> = {}) {
  return render(
    <SettingsProvider register={vi.fn()} unregister={vi.fn()}>
      <WorkersSection
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
  api.get.mockReset();
  api.put.mockReset();
  toast.mockReset();
  api.get.mockResolvedValue([]);
});
afterEach(cleanup);

// Both settings described a routing model BP-358 replaced: one nominated user per project, and a
// switch widening the claim to unassigned work. A task now goes to the machine of the person it
// was assigned to, so neither has anything left to say.
describe("WorkersSection", () => {
  it("offers neither a nominee nor a claim scope", async () => {
    renderSection(true);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    expect(screen.queryByText(/hand tasks over to/i)).toBeNull();
    expect(screen.queryByText(/tasks a worker may take/i)).toBeNull();
  });

  it("still offers the switch that enables workers at all", async () => {
    renderSection(true);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    expect(screen.getByText(/let workers run tasks for this project/i)).not.toBeNull();
  });

  // The hint used to describe a scope; it now has to describe routing on its own, or it promises a
  // choice the settings screen no longer offers
  it("describes the new routing on the enable switch's hint", async () => {
    renderSection(true);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    expect(
      screen.getByText(
        "A task goes to the machine of the person it is assigned to, once it names an agent."
      )
    ).not.toBeNull();
  });
});
