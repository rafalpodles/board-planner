// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { WorkersSection } from "./WorkersSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject } from "@/types";

const { api, toast, store } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn() },
  toast: vi.fn(),
  store: { allAgents: [] as Record<string, unknown>[], loading: false },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/app/(app)/agents/store", () => ({ useStore: () => store }));

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
  api.put.mockResolvedValue({ ok: true });
  store.allAgents = [];
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

function run(over: Record<string, unknown> = {}) {
  return {
    _id: "r1",
    taskKey: "TP-7",
    agentName: "Default",
    outcome: "failed",
    refusedBy: "",
    detail: "the build failed: 2 tests red",
    minutes: 4,
    costUsd: 0.42,
    finishedAt: new Date().toISOString(),
    ...over,
  };
}

function answerWithRuns(...runs: Record<string, unknown>[]) {
  api.get.mockImplementation((url: string) =>
    Promise.resolve(url.includes("/runs") ? runs : [])
  );
}

// BP-432: the detail was written by the worker on every exit and read by nobody. It was already in
// this response — only the rendering was missing.
describe("what a finished run said on the way out", () => {
  it("renders the detail on the run's row", async () => {
    answerWithRuns(run());

    renderSection(true);

    expect((await screen.findByTestId("run-detail")).textContent).toBe(
      "the build failed: 2 tests red"
    );
  });

  // The control: a refusal files the gate's key and leaves the detail empty, so a blank here is the
  // record being what it is rather than the rendering failing
  it("names the gate on a refusal, which records no detail", async () => {
    answerWithRuns(run({ outcome: "refused", refusedBy: "diff-size", detail: "" }));

    renderSection(true);

    expect(await screen.findByText("Refused: diff-size")).not.toBeNull();
    expect(screen.queryByTestId("run-detail")).toBeNull();
  });
});


/**
 * BP-458. Four things wrong with one control: it offered agents from boards this project is not,
 * swallowed the server's refusal in a bare `catch`, showed an empty box when no default was set,
 * and could not be cleared once one was.
 */
describe("the project's default agent", () => {
  const OURS = { _id: "a1", name: "Ours", scope: "project", projectId: "p1", projectName: "Test Project", description: "" };
  const THEIRS = { _id: "a2", name: "Theirs", scope: "project", projectId: "p9", projectName: "Other Board", description: "" };
  const GLOBAL = { _id: "a3", name: "Default", scope: "global", projectId: null, projectName: null, description: "" };
  const MINE = { _id: "a4", name: "My own", scope: "user", projectId: null, projectName: null, description: "" };

  // Found by the heading beside it, not by one of its options: keying on "No default" made every
  // test in here go red when that option was removed, so one mutation lit four lamps.
  function picker() {
    const heading = screen.getByText("Default agent");
    return heading.parentElement!.querySelector("select") as HTMLSelectElement;
  }

  it("offers this board's agents and the global ones, and no others", async () => {
    store.allAgents = [OURS, THEIRS, GLOBAL, MINE] as never;
    renderSection(true);

    const options = [...picker().querySelectorAll("option")].map((o) => o.textContent || "");
    // The control: withholding everything would satisfy the negatives on its own
    expect(options.join("|")).toContain("Ours");
    expect(options.join("|")).toContain("Default");
    expect(options.join("|")).not.toContain("Theirs");
    expect(options.join("|")).not.toContain("My own");
  });

  it("says what no default means instead of showing an empty box", async () => {
    store.allAgents = [GLOBAL] as never;
    renderSection(true);

    const select = picker();
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.textContent).toContain("No default");
  });

  it("can be cleared once one is set", async () => {
    store.allAgents = [GLOBAL] as never;
    renderSection(true, { worker: { ...project().worker!, agent: "a3" } } as Partial<ApiProject>);

    const select = picker();
    expect(select.value).toBe("a3");

    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/projects/p1/agent", { agentId: "" })
    );
  });

  it("says why a refused choice snapped back, rather than reverting in silence", async () => {
    store.allAgents = [OURS, GLOBAL] as never;
    api.put.mockRejectedValueOnce(new Error("That agent has nothing in it yet"));
    renderSection(true);

    fireEvent.change(picker(), { target: { value: "a1" } });

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toContain("nothing in it yet");
    // and the control is back where it was
    await waitFor(() => expect(picker().value).toBe(""));
  });
});
