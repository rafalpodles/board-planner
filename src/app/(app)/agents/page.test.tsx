// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import type { ApiAgentBlock } from "@/types";

const isAdmin = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAdmin: isAdmin.value, onUnauthorized: vi.fn(), noteApiStatus: vi.fn() }),
}));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => ({ projects: [] }) }));
const catalog = vi.hoisted(() => ({
  steps: [] as ApiAgentBlock[],
  gates: [] as ApiAgentBlock[],
  updateBlock: vi.fn(),
  addBlock: vi.fn(),
}));
vi.mock("./store", () => ({
  useStore: () => ({
    loading: false,
    allAgents: [],
    allSteps: catalog.steps,
    allGates: catalog.gates,
    addAgent: vi.fn(),
    addBlock: catalog.addBlock,
    updateBlock: catalog.updateBlock,
    removeBlock: vi.fn(),
    removeAgent: vi.fn(),
  }),
}));

const { default: AgentsPage } = await import("./page");

afterEach(() => {
  cleanup();
  isAdmin.value = true;
  catalog.steps = [];
  catalog.gates = [];
  catalog.updateBlock.mockReset();
  catalog.addBlock.mockReset();
});

async function openTab(label: string) {
  render(<AgentsPage />);
  const tab = screen.getAllByRole("tab").find((t) => t.textContent === label);
  await act(async () => tab!.click());
}

/**
 * A step block's prompt is what a worker executes on somebody's machine, so authoring one became
 * instance-admin in BP-345 — and the button did not move with the endpoint. A non-admin filled the
 * dialog in, clicked Create, and got an unhandled rejection: the modal stayed open with the typed
 * prompt still in it and nothing said why.
 */
describe("who is offered the catalog's actions", () => {
  it("offers New agent to everyone, because composing from existing blocks is open", async () => {
    isAdmin.value = false;
    await openTab("Agents");

    expect(screen.queryByRole("button", { name: "New agent" })).not.toBeNull();
  });

  it.each(["Gates", "Steps"])("withholds the %s action from a non-admin, and says who authors", async (tab) => {
    isAdmin.value = false;
    await openTab(tab);

    expect(screen.queryByRole("button", { name: `New ${tab.toLowerCase().slice(0, -1)}` })).toBeNull();
    expect(screen.getByText(/admin authors/i)).not.toBeNull();
  });

  // Without this the two refusals above would pass on a page that offers nothing to anybody
  it.each(["Gates", "Steps"])("offers the %s action to an admin", async (tab) => {
    await openTab(tab);

    const name = `New ${tab.toLowerCase().slice(0, -1)}`;
    expect(screen.queryByRole("button", { name })).not.toBeNull();
    expect(screen.queryByText(/admin authors/i)).toBeNull();
  });
});

const IMPLEMENT: ApiAgentBlock = {
  _id: "b-implement",
  key: "implement",
  kind: "step",
  name: "Implement",
  description: "Reads the task, makes the change, writes a test for it.",
  builtIn: true,
  gateKind: "",
  params: {},
  prompt: "Make the change.",
  capability: "edit",
  provider: "claude",
  model: "opus",
  fallbackModel: "sonnet",
  deterministic: false,
};

const PUSH: ApiAgentBlock = {
  ...IMPLEMENT,
  _id: "b-push",
  key: "push",
  name: "Push",
  prompt: "",
  capability: "read-only",
  model: "",
  fallbackModel: "",
  deterministic: true,
};

async function openStep(block: ApiAgentBlock) {
  catalog.steps = [block];
  await openTab("Steps");
  await act(async () => screen.getByRole("button", { name: block.name }).click());
  return screen.getByRole("dialog");
}

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;

// BP-743. The list says "read and write · opus" and New step asks for both; the edit dialog of the
// same step showed neither.
describe("editing a step shows what it runs as", () => {
  it("shows an admin the step's model and what it may touch, and saves a change to either", async () => {
    catalog.updateBlock.mockResolvedValue(undefined);
    await openStep(IMPLEMENT);

    expect(select("Model").value).toBe("opus");
    expect(select("What it may touch").value).toBe("edit");
    expect(select("Model").disabled).toBe(false);
    expect(select("What it may touch").disabled).toBe(false);
    expect(screen.getByText("Can change files. The worker commits afterwards.")).not.toBeNull();

    fireEvent.change(select("Model"), { target: { value: "sonnet" } });
    await act(async () => screen.getByRole("button", { name: "Save" }).click());

    expect(catalog.updateBlock).toHaveBeenCalledOnce();
    const [id, patch] = catalog.updateBlock.mock.calls[0];
    expect(id).toBe("b-implement");
    expect(patch).toMatchObject({ name: "Implement", model: "sonnet" });
    // Unchanged, so not sent: a value stored before the server checked it must not block a rename
    expect(patch).not.toHaveProperty("capability");
  });

  it("shows a reader who may not change it the same values, and nothing that edits them", async () => {
    isAdmin.value = false;
    await openStep(IMPLEMENT);

    // Read-only fields rather than disabled selects: those are dimmed and skipped by Tab
    for (const [label, shown] of [
      ["Model", "Opus"],
      ["What it may touch", "Read and write"],
    ]) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      expect(field.tagName, label).toBe("INPUT");
      expect(field.value, label).toBe(shown);
      expect(field.readOnly, label).toBe(true);
      expect(field.disabled, label).toBe(false);
    }
    expect(screen.getByText("Can change files. The worker commits afterwards.")).not.toBeNull();
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.readOnly).toBe(true);
    expect(name.required).toBe(false);
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByLabelText("What it should do") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).not.toBeNull();
  });

  it("offers neither on a step the worker performs itself", async () => {
    await openStep(PUSH);

    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.queryByLabelText("What it may touch")).toBeNull();
    expect(screen.getByText(/calls no model/)).not.toBeNull();
  });

  it("shows a step with no model of its own as running the worker's, rather than as Opus", async () => {
    await openStep({ ...IMPLEMENT, model: "" });

    expect(select("Model").value).toBe("");
    expect(select("Model").selectedOptions[0].textContent).toBe("The worker's own");
  });
});

describe("a refusal from the server", () => {
  it("is shown in the dialog, which stays open with the edit in it", async () => {
    catalog.updateBlock.mockRejectedValue(
      new Error("This would break Careful: Nothing pushes the work.")
    );
    await openStep({ ...IMPLEMENT, capability: "read-only" });

    fireEvent.change(select("What it may touch"), { target: { value: "edit" } });
    await act(async () => screen.getByRole("button", { name: "Save" }).click());

    // Announced: focus stays on Save, so text that is only painted is never heard
    expect(screen.getByRole("alert").textContent).toBe(
      "This would break Careful: Nothing pushes the work."
    );
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(select("What it may touch").value).toBe("edit");
  });
});

describe("a refusal while creating a block", () => {
  it("is announced, and the dialog keeps what was typed", async () => {
    catalog.addBlock.mockRejectedValue(new Error("model must be a model name such as opus or sonnet"));
    await openTab("Steps");
    await act(async () => screen.getByRole("button", { name: "New step" }).click());

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Write the tests" } });
    await act(async () => screen.getByRole("button", { name: "Create" }).click());

    expect(screen.getByRole("alert").textContent).toBe(
      "model must be a model name such as opus or sonnet"
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Write the tests");
  });
});

describe("a gate, for a reader who may not change it", () => {
  const SIZE: ApiAgentBlock = {
    ...IMPLEMENT,
    _id: "b-size",
    key: "diff-size",
    kind: "gate",
    name: "Size",
    gateKind: "diff-size",
    params: { maxLines: "400", maxFiles: "10" },
    prompt: "",
    model: "",
  };

  it("shows its parameters without letting them be typed into or saved", async () => {
    isAdmin.value = false;
    catalog.gates = [SIZE];
    await openTab("Gates");
    await act(async () => screen.getByRole("button", { name: "Size" }).click());

    const lines = screen.getByLabelText("Most lines") as HTMLInputElement;
    expect(lines.value).toBe("400");
    expect(lines.readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("shows a chosen parameter as a read-only field with its label", async () => {
    isAdmin.value = false;
    catalog.gates = [
      {
        ...SIZE,
        _id: "b-review",
        key: "review",
        name: "Reviewed",
        gateKind: "review",
        params: { focus: "security", model: "opus" },
      },
    ];
    await openTab("Gates");
    await act(async () => screen.getByRole("button", { name: "Reviewed" }).click());

    const focus = screen.getByLabelText("Looking for") as HTMLInputElement;
    expect(focus.tagName).toBe("INPUT");
    expect(focus.value).toBe("Security");
    expect(focus.readOnly).toBe(true);
    expect((screen.getByLabelText("Model") as HTMLInputElement).readOnly).toBe(true);
  });

  it("shows a stored model the form does not offer as itself, rather than as the first option", async () => {
    catalog.gates = [
      {
        ...SIZE,
        _id: "b-review",
        key: "review",
        name: "Reviewed",
        gateKind: "review",
        params: { focus: "general", model: "haiku" },
      },
    ];
    await openTab("Gates");
    await act(async () => screen.getByRole("button", { name: "Reviewed" }).click());

    const model = select("Model");
    expect(model.value).toBe("haiku");
    expect(model.selectedOptions[0].textContent).toBe("haiku");
  });

  it("lets an admin change them", async () => {
    catalog.gates = [SIZE];
    await openTab("Gates");
    await act(async () => screen.getByRole("button", { name: "Size" }).click());

    expect((screen.getByLabelText("Most lines") as HTMLInputElement).readOnly).toBe(false);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeNull();
  });
});

// Deleting a block is instance-admin on the server, so the control was a 403 waiting to happen
describe("who is offered Delete on a block", () => {
  const MINE: ApiAgentBlock = { ...IMPLEMENT, _id: "b-mine", key: "mine", name: "Mine", builtIn: false };

  it("withholds it from a reader who may not delete", async () => {
    isAdmin.value = false;
    catalog.steps = [MINE];
    await openTab("Steps");

    expect(screen.getByRole("button", { name: "Mine" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Mine" })).toBeNull();
  });

  it("offers it to an admin", async () => {
    catalog.steps = [MINE];
    await openTab("Steps");

    expect(screen.queryByRole("button", { name: "Delete Mine" })).not.toBeNull();
  });
});

// BP-987. A step and the review gate name the coding CLI they run on, and the model goes with it
describe("choosing the coding CLI of a step", () => {
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
  const CODEX_NOTE = /shell and has network access/;

  it("shows an admin Claude Code for a step stored before the choice existed, with its model list", async () => {
    await openStep({ ...IMPLEMENT, provider: undefined as never });

    expect(select("Runs on").value).toBe("claude");
    expect(select("Model").value).toBe("opus");
    expect(screen.queryByText(CODEX_NOTE)).toBeNull();
  });

  it("swaps the model list for a typed model, with a plain note, when Codex is chosen, and sends the pair", async () => {
    catalog.updateBlock.mockResolvedValue(undefined);
    await openStep(IMPLEMENT);

    fireEvent.change(select("Runs on"), { target: { value: "codex" } });

    expect(field("Model").tagName).toBe("INPUT");
    expect(field("Model").value).toBe("");
    expect(screen.getByText(CODEX_NOTE)).not.toBeNull();
    // A Claude model is not offered to Codex, and none is guessed: the save waits for a name
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field("Model"), { target: { value: " gpt-6.1-sol " } });
    await act(async () => screen.getByRole("button", { name: "Save" }).click());

    expect(catalog.updateBlock.mock.calls[0][1]).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
  });

  it("gives the Claude model back as the default when the choice goes back", async () => {
    await openStep({ ...IMPLEMENT, provider: "codex", model: "gpt-5" });
    expect(field("Model").value).toBe("gpt-5");

    fireEvent.change(select("Runs on"), { target: { value: "claude" } });

    expect(select("Model").value).toBe("opus");
  });

  it("sends neither provider nor model when the edit touches neither, so an old step can still be renamed", async () => {
    catalog.updateBlock.mockResolvedValue(undefined);
    await openStep(IMPLEMENT);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Implement it" } });
    await act(async () => screen.getByRole("button", { name: "Save" }).click());

    const patch = catalog.updateBlock.mock.calls[0][1];
    expect(patch).not.toHaveProperty("provider");
    expect(patch).not.toHaveProperty("model");
  });

  it("shows a reader who may not change it the provider as a read-only field", async () => {
    isAdmin.value = false;
    await openStep({ ...IMPLEMENT, provider: "codex", model: "gpt-5" });

    expect(field("Runs on").tagName).toBe("INPUT");
    expect(field("Runs on").value).toBe("Codex");
    expect(field("Runs on").readOnly).toBe(true);
    expect(field("Model").readOnly).toBe(true);
  });

  it("names the provider in the list beside a step that is not on Claude Code, and nothing extra for one that is", async () => {
    const { blockSummary } = await import("./components/lists");

    expect(blockSummary({ ...IMPLEMENT, provider: "codex", model: "gpt-5" })).toBe("read and write · Codex · gpt-5");
    expect(blockSummary(IMPLEMENT)).toBe("read and write · opus");
  });

  it("names the reviewer in the list beside a review on Codex", async () => {
    const { blockSummary } = await import("./components/lists");

    expect(
      blockSummary({ ...IMPLEMENT, kind: "gate", gateKind: "review", params: { focus: "general", provider: "codex", model: "gpt-5" } })
    ).toBe("looking for Anything wrong · reviewer Codex · model gpt-5");
  });

  it("creates a step on Codex only once it names a model", async () => {
    catalog.addBlock.mockResolvedValue(undefined);
    await openTab("Steps");
    await act(async () => screen.getByRole("button", { name: "New step" }).click());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Write it on Codex" } });
    fireEvent.change(select("Runs on"), { target: { value: "codex" } });

    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field("Model"), { target: { value: "gpt-6.1-sol" } });
    await act(async () => screen.getByRole("button", { name: "Create" }).click());

    expect(catalog.addBlock.mock.calls[0][0]).toMatchObject({ kind: "step", provider: "codex", model: "gpt-6.1-sol" });
  });

  it("creates a step on Claude Code by default, as before", async () => {
    catalog.addBlock.mockResolvedValue(undefined);
    await openTab("Steps");
    await act(async () => screen.getByRole("button", { name: "New step" }).click());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Plain" } });
    await act(async () => screen.getByRole("button", { name: "Create" }).click());

    expect(catalog.addBlock.mock.calls[0][0]).toMatchObject({ provider: "claude", model: "opus" });
  });
});

describe("choosing the reviewer of the Reviewed gate", () => {
  const REVIEW: ApiAgentBlock = {
    ...IMPLEMENT,
    _id: "b-review",
    key: "review",
    kind: "gate",
    name: "Reviewed",
    gateKind: "review",
    params: { focus: "general", provider: "claude", model: "opus" },
    prompt: "",
    model: "",
  };
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

  it("offers Claude Code and Codex, with the model beside the reviewer chosen", async () => {
    await openTab("Gates");
    await act(async () => screen.getByRole("button", { name: "New gate" }).click());
    fireEvent.change(select("What it checks"), { target: { value: "review" } });

    expect(select("Reviewer").value).toBe("claude");
    expect(select("Model").value).toBe("opus");

    fireEvent.change(select("Reviewer"), { target: { value: "codex" } });

    expect(field("Model").tagName).toBe("INPUT");
    expect(field("Model").value).toBe("");
  });

  it("creates a review on Codex with its provider and model among the parameters", async () => {
    catalog.addBlock.mockResolvedValue(undefined);
    await openTab("Gates");
    await act(async () => screen.getByRole("button", { name: "New gate" }).click());
    fireEvent.change(select("What it checks"), { target: { value: "review" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reviewed on Codex" } });
    fireEvent.change(select("Reviewer"), { target: { value: "codex" } });
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field("Model"), { target: { value: "gpt-6.1-sol" } });
    await act(async () => screen.getByRole("button", { name: "Create" }).click());

    expect(catalog.addBlock.mock.calls[0][0]).toMatchObject({
      kind: "gate",
      gateKind: "review",
      params: { focus: "general", provider: "codex", model: "gpt-6.1-sol" },
    });
  });

  it("shows an existing review's reviewer, saved with the model it goes with", async () => {
    catalog.updateBlock.mockResolvedValue(undefined);
    catalog.gates = [REVIEW];
    await openTab("Gates");
    await act(async () => screen.getByRole("button", { name: "Reviewed" }).click());

    expect(select("Reviewer").value).toBe("claude");
    fireEvent.change(select("Reviewer"), { target: { value: "codex" } });
    fireEvent.change(field("Model"), { target: { value: "gpt-5" } });
    await act(async () => screen.getByRole("button", { name: "Save" }).click());

    expect(catalog.updateBlock.mock.calls[0][1]).toMatchObject({ params: { provider: "codex", model: "gpt-5" } });
  });
});
