// @vitest-environment happy-dom
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";
import { NewTaskModal } from "@/components/tasks/NewTaskModal";
import { TaskForm } from "@/components/tasks/TaskForm";
import {
  EditBlockDialog,
  NewAgentDialog,
  NewGateDialog,
  NewStepDialog,
} from "@/app/(app)/agents/components/dialogs";
import { EnrolWorkerModal } from "@/components/settings/EnrolWorkerModal";
import { useStore } from "@/app/(app)/agents/store";
import { AgentComposition } from "@/types";
import { ApiAgentBlock } from "@/types";
import { DangerAction } from "@/components/settings/DangerAction";
import { CompleteSprintDialog } from "@/components/sprints/CompleteSprintDialog";
import { SprintFormModal } from "@/components/sprints/SprintFormModal";
import { ApiProject, ApiSprint } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), upload: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
// Stands in for the editor so the upload it owns can be driven from a test: the file goes through
// the form, and the form is what reports the write to the dialog around it.
vi.mock("@/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: ({ onFileUpload }: { onFileUpload?: (file: File) => Promise<string> }) => (
    <button onClick={() => onFileUpload?.(new File(["x"], "shot.png"))}>Attach a file</button>
  ),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

beforeEach(() => {
  // Reset, not clear: a test that leaves `api.get` rejecting would otherwise mount the next test's
  // store into a failed load
  vi.resetAllMocks();
});
afterEach(cleanup);

/**
 * BP-565. `Modal`'s own tests prove the prop works; these prove it is wired, per dialog. Without
 * them every `closeDisabled={…}` in the tree could be deleted with a green suite — the e2e covers
 * exactly one of the callers, and eight would go unnoticed.
 *
 * Escape is the cheapest of the three exits to drive and the one that goes through `useFocusTrap`,
 * so it is the one asserted; `Modal.test.tsx` covers the scrim and the × against the same gate.
 */
function escape() {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
  });
}

function sprint(): ApiSprint {
  return {
    _id: "s1",
    name: "Sprint 1",
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-01-15T00:00:00Z",
    goal: "",
    status: "active",
    taskCount: 3,
    doneCount: 1,
  } as ApiSprint;
}

describe("a dialog with a request in flight refuses Escape", () => {
  it("ConfirmDialog, mid-delete", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        loading
        onClose={onClose}
        onConfirm={() => {}}
        title="Delete Task"
        message="gone for good"
      />
    );
    escape();
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <ConfirmDialog
        open
        loading={false}
        onClose={onClose}
        onConfirm={() => {}}
        title="Delete Task"
        message="gone for good"
      />
    );
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("SprintFormModal, mid-save", () => {
    const onClose = vi.fn();
    render(
      <SprintFormModal sprints={[]} editing={null} saving onSubmit={() => {}} onClose={onClose} />
    );
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("CompleteSprintDialog, mid-completion", () => {
    const onClose = vi.fn();
    render(
      <CompleteSprintDialog sprint={sprint()} completing onComplete={() => {}} onClose={onClose} />
    );
    escape();
    expect(onClose).not.toHaveBeenCalled();
    // Both answers are one PUT each, and the second one lands on a sprint that is already closed
    expect(
      (screen.getByRole("button", { name: "Keep in Sprint" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  /**
   * DangerAction owns its own flag, so this drives the real thing: a confirm whose promise is still
   * unresolved. It backs project deletion and custom-field deletion, where a dialog dismissed
   * mid-request leaves the operator with a toast about something they can no longer see.
   */
  it("DangerAction, while its confirm is still running", async () => {
    let finish = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));

    render(
      <DangerAction
        label="Delete project"
        title="Deleting a project"
        message="gone for good"
        confirmLabel="Delete it"
        onConfirm={() => held}
      />
    );
    act(() => screen.getByRole("button", { name: "Delete project" }).click());
    const dialog = screen.getByRole("dialog", { name: "Deleting a project" });
    await act(async () => {
      screen.getByRole("button", { name: "Delete it" }).click();
    });

    escape();
    expect(screen.getByRole("dialog", { name: "Deleting a project" })).toBe(dialog);
    expect(dialog.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      finish();
      await held;
    });
    expect(screen.queryByRole("dialog", { name: "Deleting a project" })).toBeNull();
  });
  /**
   * The busiest dialog in the app, and the one with the most to lose: the whole typed task lives in
   * the form, and `TaskForm` holds the in-flight flag, so the flag has to be reported upwards for
   * the dialog around it to refuse anything.
   */
  it("NewTaskModal, while the task is being created", async () => {
    api.get.mockResolvedValue([]);
    let finish: (value: unknown) => void = () => {};
    api.post.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    const onClose = vi.fn();
    const project = { _id: "p1", key: "TP", name: "Test", categories: [], columns: [] };
    render(
      <NewTaskModal
        projectId="p1"
        project={project as unknown as ApiProject}
        sprints={[]}
        scope={null}
        open
        onClose={onClose}
        onSaved={() => {}}
      />
    );

    await act(async () => {
      (screen.getByLabelText(/title/i) as HTMLInputElement).focus();
    });
    const title = screen.getByLabelText(/title/i) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        title,
        "Something typed"
      );
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: "Create Task" }).click();
    });

    escape();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "New Task" }).getAttribute("aria-busy")).toBe("true");
    expect(title.value).toBe("Something typed");

    await act(async () => {
      finish({ _id: "t1" });
    });
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * The one dialog in the agents file that had no in-flight state at all: Save could be clicked
   * into two PUTs, and every exit dismissed it mid-write.
   */
  it("EditBlockDialog, mid-save", async () => {
    let finish = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));
    const onClose = vi.fn();
    const block = {
      _id: "b1",
      kind: "step",
      name: "Write the tests",
      description: "",
      prompt: "do it",
      params: {},
    } as unknown as ApiAgentBlock;

    render(<EditBlockDialog block={block} onClose={onClose} onSave={() => held} />);
    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });

    escape();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true
    );

    await act(async () => {
      finish();
      await held;
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("NewAgentDialog, while the agent is being created", async () => {
    let finish = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));
    const onClose = vi.fn();

    render(<NewAgentDialog open projects={[]} onClose={onClose} onCreate={() => held} />);
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Careful");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: "Create" }).click();
    });

    escape();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      finish();
      await held;
    });
    escape();
    expect(onClose).toHaveBeenCalled();
  });

  it("EnrolWorkerModal, while the token is being minted", async () => {
    let finish: (value: unknown) => void = () => {};
    api.post.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const onClose = vi.fn();

    render(<EnrolWorkerModal open onClose={onClose} />);
    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    escape();
    expect(onClose).not.toHaveBeenCalled();

    // The token is shown once and cannot be fetched again, so a dialog dismissed mid-mint loses it
    // for good — the worker it was for has to be enrolled with a second one.
    await act(async () => {
      finish({ token: "cpe_abc", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    });
    expect(screen.getByText("cpe_abc")).toBeTruthy();
  });

  /**
   * The upload is the form's other write, and the one nobody watches: it lands in the description
   * and takes the whole typed task with it if the dialog goes.
   */
  it("NewTaskModal, while a dropped file is uploading", async () => {
    api.get.mockResolvedValue([]);
    let finish: (value: unknown) => void = () => {};
    api.upload.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    const onClose = vi.fn();
    const project = { _id: "p1", key: "TP", name: "Test", categories: [], columns: [] };
    render(
      <NewTaskModal
        projectId="p1"
        project={project as unknown as ApiProject}
        sprints={[]}
        scope={null}
        open
        onClose={onClose}
        onSaved={() => {}}
      />
    );

    await act(async () => {
      screen.getByRole("button", { name: "Attach a file" }).click();
    });

    escape();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "New Task" }).getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      finish({ markdown: "![shot](/u/1)" });
    });
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("NewGateDialog and NewStepDialog, while the block is being created", async () => {
    for (const [title, Dialog] of [
      ["New gate", NewGateDialog],
      ["New step", NewStepDialog],
    ] as const) {
      let finish = () => {};
      const held = new Promise<void>((resolve) => (finish = resolve));
      const onClose = vi.fn();
      const view = render(<Dialog open onClose={onClose} onCreate={() => held} />);

      const name = screen.getByLabelText("Name") as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "One");
        name.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        screen.getByRole("button", { name: "Create" }).click();
      });

      escape();
      expect(onClose, title).not.toHaveBeenCalled();

      await act(async () => {
        finish();
        await held;
      });
      view.unmount();
    }
  });

  /**
   * The report goes through a ref so it survives a caller that passes an inline arrow: read from
   * the deps directly, every render of that caller would tear the subscription down and rebuild it,
   * telling the dialog it was free and then busy again — a flicker of an unlocked dialog in the
   * middle of a write.
   */
  it("does not flicker the flag when its caller re-renders with a new callback", async () => {
    api.get.mockResolvedValue([]);
    api.post.mockImplementation(() => new Promise(() => {}));
    const seen: boolean[] = [];

    function Parent({ tick }: { tick: number }) {
      return (
        <>
          <span>tick {tick}</span>
          <TaskForm
            projectId="p1"
            projectKey="TP"
            onSaved={() => {}}
            onCancel={() => {}}
            onBusyChange={(value) => seen.push(value)}
          />
        </>
      );
    }

    const view = render(<Parent tick={1} />);
    const title = screen.getByLabelText(/title/i) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "One");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: "Create Task" }).click();
    });
    expect(seen).toEqual([false, true]);

    await act(async () => {
      view.rerender(<Parent tick={2} />);
    });
    expect(seen).toEqual([false, true]);
  });

  /**
   * The AI fill reports its result with a toast only while the form is still there, which rests on
   * a mounted ref — and a ref that is set once at creation is wrong under StrictMode, where the
   * first mount is torn down before the real one. The failure would be dev-only and silent: no fill
   * ever announces itself.
   */
  it("still announces an AI fill after StrictMode's throwaway first mount", async () => {
    api.get.mockImplementation((path: string) =>
      path.includes("/ai/generate-task") ? Promise.resolve({ enabled: true }) : Promise.resolve([])
    );
    api.post.mockResolvedValue({
      title: "Filled",
      description: "",
      category: "user-story",
      acceptanceCriteria: "",
      suggestedBlockedBy: [],
      suggestedBlocking: [],
    });

    render(
      <StrictMode>
        <TaskForm projectId="p1" projectKey="TP" onSaved={() => {}} onCancel={() => {}} />
      </StrictMode>
    );

    const prompt = (await screen.findByPlaceholderText(/describe/i)) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        prompt,
        "a login screen"
      );
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: "Generate" }).click();
    });

    expect(toast).toHaveBeenCalledWith("Fields filled by AI — review and save", "success");
  });

});

describe("a write whose list refresh fails", () => {
  /**
   * The write landed; only the list behind the dialog did not. Reported as the write failing, the
   * dialog stayed open over a record that already existed, with Create inviting a second one.
   *
   * BP-577 landed the answer in the store itself — `load` catches and raises its own banner rather
   * than rejecting into whatever awaited it — so this holds that seam from the dialog's side.
   */
  it("NewAgentDialog does not call a failed refresh a failed create", async () => {
    const onClose = vi.fn();
    function Host() {
      const store = useStore();
      return <NewAgentDialog open projects={[]} onClose={onClose} onCreate={store.addAgent} />;
    }

    api.get.mockResolvedValue([]);
    render(<Host />);
    await act(async () => {});

    api.post.mockResolvedValue({ _id: "a1" });
    api.get.mockRejectedValue(new Error("network down"));

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Careful");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: "Create" }).click();
    });

    expect(screen.queryByText("network down")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * The store's other writes go the same way. The composition editor is the one that shows it worst
   * — `agents/[agentId]/page.tsx` renders "Not saved." over whatever the store rejected with — but
   * this covers the store, not that banner.
   */
  it("saveComposition survives a refetch that fails", async () => {
    api.get.mockResolvedValue([]);
    api.put.mockResolvedValue({});
    let save: (() => Promise<void>) | null = null;
    const composition: AgentComposition = {
      analysis: [],
      implementation: [],
      verification: [],
      delivery: [],
    };

    function Host() {
      const store = useStore();
      save = () => store.saveComposition("a1", composition);
      return null;
    }
    render(<Host />);
    await act(async () => {});

    api.get.mockRejectedValue(new Error("network down"));
    await act(async () => {
      await expect(save!()).resolves.toBeUndefined();
    });
    expect(api.put).toHaveBeenCalledWith("/api/agents/a1", { composition });
  });
});
