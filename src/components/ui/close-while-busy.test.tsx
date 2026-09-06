// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";
import { NewTaskModal } from "@/components/tasks/NewTaskModal";
import {
  EditBlockDialog,
  NewAgentDialog,
  NewGateDialog,
  NewStepDialog,
} from "@/app/(app)/agents/components/dialogs";
import { EnrolWorkerModal } from "@/components/settings/EnrolWorkerModal";
import { ApiAgentBlock } from "@/types";
import { DangerAction } from "@/components/settings/DangerAction";
import { CompleteSprintDialog } from "@/components/sprints/CompleteSprintDialog";
import { SprintFormModal } from "@/components/sprints/SprintFormModal";
import { ApiProject, ApiSprint } from "@/types";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), upload: vi.fn() },
}));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
// Stands in for the editor so the upload it owns can be driven from a test: the file goes through
// the form, and the form is what reports the write to the dialog around it.
vi.mock("@/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: ({ onFileUpload }: { onFileUpload?: (file: File) => Promise<string> }) => (
    <button onClick={() => onFileUpload?.(new File(["x"], "shot.png"))}>Attach a file</button>
  ),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

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
});
