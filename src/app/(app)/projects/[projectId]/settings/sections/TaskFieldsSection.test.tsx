// @vitest-environment happy-dom
import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { TaskFieldsSection } from "./TaskFieldsSection";
import { SettingsProvider, useDirtyRegistry } from "@/components/settings/settings-context";
import { ApiCustomField, ApiProject } from "@/types";
import { SectionProps } from "./types";

const { api, toast } = vi.hoisted(() => ({
  api: { post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

function render(ui: React.ReactElement) {
  return rtlRender(
    <SettingsProvider register={vi.fn()} unregister={vi.fn()}>
      {ui}
    </SettingsProvider>
  );
}

// The shape `use-api.ts` actually throws — a real Error with status/body riding along —
// not a plain object, so a test asserting on `.message` behaviour stays honest.
function apiError(message: string, status: number) {
  return Object.assign(new Error(message), { status, body: { error: message } });
}

// A real patchProject, so a create/archive/delete flow's effect on `project` is visible
// on the next render instead of vanishing into a `vi.fn()`.
function Harness({ initial }: { initial: ApiProject }) {
  const [project, setProject] = useState(initial);
  function patchProject(
    patch: Partial<ApiProject> | ((prev: ApiProject) => Partial<ApiProject>)
  ) {
    setProject((p) => ({ ...p, ...(typeof patch === "function" ? patch(p) : patch) }));
  }
  return (
    <>
      <span data-testid="estimate-field-id">{project.estimateFieldId}</span>
      <TaskFieldsSection
        projectId="p1"
        project={project}
        patchProject={patchProject}
        replaceProject={vi.fn()}
        isAdmin={false}
        stats={null}
      />
    </>
  );
}

// The real registry the save bar reads, so "how many edits are pending" is answered by the
// same code the page uses rather than by an assertion about a mock.
function DirtyHarness({ initial }: { initial: ApiProject }) {
  const [project, setProject] = useState(initial);
  const { register, unregister, pending, total } = useDirtyRegistry();
  function patchProject(
    patch: Partial<ApiProject> | ((prev: ApiProject) => Partial<ApiProject>)
  ) {
    setProject((p) => ({ ...p, ...(typeof patch === "function" ? patch(p) : patch) }));
  }
  return (
    <SettingsProvider register={register} unregister={unregister}>
      <span data-testid="pending-total">{total}</span>
      <span data-testid="saved-estimate-field-id">{project.estimateFieldId}</span>
      <button onClick={() => pending.forEach((g) => g.save())}>Save all</button>
      <button onClick={() => pending.forEach((g) => g.discard())}>Discard all</button>
      <TaskFieldsSection
        projectId="p1"
        project={project}
        patchProject={patchProject}
        replaceProject={vi.fn()}
        isAdmin={false}
        stats={null}
      />
    </SettingsProvider>
  );
}

const numberFieldId = "f-number";
const otherFieldId = "f-other-number";

const project = {
  _id: "p1",
  key: "TP",
  name: "Test Project",
  description: "",
  icon: "",
  canAdmin: true,
  estimateFieldId: "",
  categories: [],
  taskTemplates: [],
  customFields: [
    {
      _id: "f-text",
      name: "Notes",
      fieldType: "text",
      options: [],
      required: false,
      order: 0,
      showOnCard: false,
      showInList: false,
      filterable: false,
      archived: false,
    },
    {
      _id: numberFieldId,
      name: "Story points",
      fieldType: "number",
      options: [],
      required: false,
      order: 1,
      showOnCard: false,
      showInList: false,
      filterable: false,
      archived: false,
    },
    {
      _id: "f-archived-number",
      name: "Old estimate",
      fieldType: "number",
      options: [],
      required: false,
      order: 2,
      showOnCard: false,
      showInList: false,
      filterable: false,
      archived: true,
    },
  ],
} as unknown as ApiProject;

const noNumericFields: ApiCustomField[] = [
  {
    _id: "f-dropdown",
    name: "Priority",
    fieldType: "dropdown",
    options: [{ id: "low", value: "Low", color: "#64748b", order: 0 }],
    required: false,
    order: 0,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
  },
  {
    _id: "f-multiselect",
    name: "Tags",
    fieldType: "multiselect",
    options: [{ id: "a", value: "A", color: "#64748b", order: 0 }],
    required: false,
    order: 1,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
  },
  {
    _id: "f-checkbox",
    name: "Blocked",
    fieldType: "checkbox",
    options: [],
    required: false,
    order: 2,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
  },
];

// Two live numeric fields, so archiving/deleting the designated one leaves the other
// in place and the picker stays rendered — the exact condition under which a stale
// `estimateFieldId` can hide behind option 0 ("None") by accident.
const twoNumericFields: ApiCustomField[] = [
  {
    _id: numberFieldId,
    name: "Story points",
    fieldType: "number",
    options: [],
    required: false,
    order: 0,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
  },
  {
    _id: otherFieldId,
    name: "Effort",
    fieldType: "number",
    options: [],
    required: false,
    order: 1,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
  },
];

let props: SectionProps;

beforeEach(() => {
  api.post.mockReset();
  api.put.mockReset();
  api.patch.mockReset();
  api.del.mockReset();
  toast.mockReset();
  props = {
    projectId: "p1",
    project,
    patchProject: vi.fn(),
    replaceProject: vi.fn(),
    isAdmin: false,
    stats: null,
  };
});
afterEach(cleanup);

describe("TaskFieldsSection save bar", () => {
  it("stops reporting pending templates once the save succeeds", async () => {
    const saved = [
      {
        _id: "t1",
        name: "Bug report",
        title: "",
        description: "",
        category: "bug",
        acceptanceCriteria: "",
      },
    ];
    api.post.mockResolvedValue(saved);

    render(<DirtyHarness initial={{ ...project, categories: [{ _id: "c1", name: "bug", color: "#ef4444" }] } as ApiProject} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add template" }));
    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "Bug report" },
    });
    expect(screen.getByTestId("pending-total").textContent).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Templates saved", "success"));
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("0"));
  });

  it("does not re-POST a template the save already created", async () => {
    api.post.mockResolvedValue([
      {
        _id: "t1",
        name: "Bug report",
        title: "",
        description: "",
        category: "bug",
        acceptanceCriteria: "",
      },
    ]);

    render(<DirtyHarness initial={{ ...project, categories: [{ _id: "c1", name: "bug", color: "#ef4444" }] } as ApiProject} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add template" }));
    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "Bug report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("0"));

    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  });

  it("stops reporting pending categories once the save succeeds", async () => {
    api.post.mockResolvedValue([{ _id: "c1", name: "Chore", color: "#64748b" }]);

    render(<DirtyHarness initial={project} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add category" }));
    fireEvent.change(screen.getByLabelText("Category name"), {
      target: { value: "Chore" },
    });
    expect(screen.getByTestId("pending-total").textContent).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Categories saved", "success"));
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("0"));
  });

  it("keeps the edits on screen and still reports them pending when the save fails", async () => {
    api.post.mockRejectedValue(apiError("Category name already in use", 409));

    render(<DirtyHarness initial={project} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add category" }));
    fireEvent.change(screen.getByLabelText("Category name"), {
      target: { value: "Chore" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Category name already in use", "error")
    );
    expect((screen.getByLabelText("Category name") as HTMLInputElement).value).toBe("Chore");
    expect(screen.getByTestId("pending-total").textContent).toBe("1");
  });
});

describe("TaskFieldsSection estimate field", () => {
  it("lists only the project's non-archived numeric fields, and None", async () => {
    render(<TaskFieldsSection {...props} />);
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["None", "Story points"]);
  });

  it("shows the project's existing designation in the picker", () => {
    render(
      <TaskFieldsSection
        {...props}
        project={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }}
      />
    );
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    expect(select.value).toBe(numberFieldId);
  });

  // BP-785: it used to be written the moment it was picked, under a footer saying nothing was unsaved
  it("waits for Save: picking a field sends nothing and counts as one unsaved change", async () => {
    rtlRender(<DirtyHarness initial={project} />);
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: numberFieldId } });

    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("1"));
    expect(select.value).toBe(numberFieldId);
    expect(select.className).toContain("border-warning/60");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("Save sends the designation and leaves nothing pending", async () => {
    api.put.mockResolvedValue({});
    rtlRender(<DirtyHarness initial={project} />);
    fireEvent.change(screen.getByLabelText("Estimate field"), { target: { value: numberFieldId } });
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("0"));
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1", { estimateFieldId: numberFieldId });
    expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe(numberFieldId);
  });

  it("Discard puts the saved choice back", async () => {
    rtlRender(
      <DirtyHarness initial={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }} />
    );
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));

    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("0"));
    expect(select.value).toBe(numberFieldId);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("keeps a refused choice pending, to retry or discard", async () => {
    api.put.mockRejectedValue(apiError("Estimate field not found", 400));
    rtlRender(<DirtyHarness initial={project} />);
    fireEvent.change(screen.getByLabelText("Estimate field"), { target: { value: numberFieldId } });
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Estimate field not found", "error"));
    expect(screen.getByTestId("pending-total").textContent).toBe("1");
    expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe("");
  });

  it("leaves nothing pending when the saved designation's field is deleted", async () => {
    api.del.mockResolvedValue([twoNumericFields[1]]);
    rtlRender(
      <DirtyHarness initial={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }} />
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete field" }));

    await waitFor(() => expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe(""));
    expect(screen.getByTestId("pending-total").textContent).toBe("0");
    expect((screen.getByLabelText("Estimate field") as HTMLSelectElement).value).toBe("");
  });

  // Review: None here would un-designate the saved field on the next Save, which nobody asked for
  it("puts an unsaved choice of a deleted field back to the saved one, not to None", async () => {
    api.del.mockResolvedValue([twoNumericFields[0]]);
    rtlRender(
      <DirtyHarness initial={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }} />
    );
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: otherFieldId } });
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("1"));

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete field" }));

    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("0"));
    expect((screen.getByLabelText("Estimate field") as HTMLSelectElement).value).toBe(numberFieldId);
    expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe(numberFieldId);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("falls back to a choice saved during this visit, not to the one the page opened with", async () => {
    api.put.mockResolvedValue({});
    api.del.mockResolvedValue([twoNumericFields[0]]);
    rtlRender(<DirtyHarness initial={{ ...project, customFields: twoNumericFields }} />);
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: numberFieldId } });
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    await waitFor(() => expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe(numberFieldId));

    fireEvent.change(select, { target: { value: otherFieldId } });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete field" }));

    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("0"));
    expect(select.value).toBe(numberFieldId);
  });

  // The fallback is read after the delete's await, so a save landing during it must count
  it("follows a choice saved while the delete was still out", async () => {
    let answerDelete!: (fields: unknown) => void;
    api.del.mockImplementation(() => new Promise((resolve) => (answerDelete = resolve)));
    api.put.mockResolvedValue({});
    rtlRender(
      <DirtyHarness initial={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }} />
    );
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: otherFieldId } });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete field" }));
    await waitFor(() => expect(api.del).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    await waitFor(() => expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe(otherFieldId));
    await act(async () => answerDelete([twoNumericFields[0]]));

    await waitFor(() => expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe(""));
    expect(select.value).toBe("");
    expect(screen.getByTestId("pending-total").textContent).toBe("0");
  });

  it("leaves a saved choice and an unsaved one alone when another field is removed", async () => {
    api.del.mockResolvedValue([twoNumericFields[0], twoNumericFields[1]]);
    const withThird = [
      ...twoNumericFields,
      { ...twoNumericFields[1], _id: "f-third", name: "Hours", order: 2 },
    ];
    rtlRender(
      <DirtyHarness initial={{ ...project, customFields: withThird, estimateFieldId: numberFieldId }} />
    );
    fireEvent.change(screen.getByLabelText("Estimate field"), { target: { value: otherFieldId } });
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("1"));

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[2]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete field" }));

    await waitFor(() => expect(screen.queryByText("Hours")).toBeNull());
    expect((screen.getByLabelText("Estimate field") as HTMLSelectElement).value).toBe(otherFieldId);
    expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe(numberFieldId);
    expect(screen.getByTestId("pending-total").textContent).toBe("1");
  });

  it("keeps the designation when the designated field is renamed", async () => {
    api.patch.mockResolvedValue([{ ...twoNumericFields[0], name: "Points" }, twoNumericFields[1]]);
    rtlRender(
      <DirtyHarness initial={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }} />
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Points" } });
    fireEvent.click(screen.getByRole("button", { name: "Save field" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save field" })).toBeNull());
    expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe(numberFieldId);
    expect((screen.getByLabelText("Estimate field") as HTMLSelectElement).value).toBe(numberFieldId);
    expect(screen.getByTestId("pending-total").textContent).toBe("0");
  });

  it("Create leaves the new field chosen and nothing pending", async () => {
    const created = { ...twoNumericFields[0], _id: "f-new" };
    api.post.mockResolvedValue([...noNumericFields, created]);
    api.put.mockResolvedValue({});
    rtlRender(<DirtyHarness initial={{ ...project, customFields: noNumericFields }} />);

    fireEvent.click(screen.getByRole("button", { name: /Create .Story points./ }));

    const select = (await screen.findByLabelText("Estimate field")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("f-new"));
    expect(screen.getByTestId("pending-total").textContent).toBe("0");
    expect(screen.getByTestId("saved-estimate-field-id").textContent).toBe("f-new");
  });

  it("drops an unsaved choice of a field that is then deleted", async () => {
    api.del.mockResolvedValue([twoNumericFields[1]]);
    rtlRender(<DirtyHarness initial={{ ...project, customFields: twoNumericFields }} />);
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: numberFieldId } });
    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("1"));

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete field" }));

    await waitFor(() => expect(screen.getByTestId("pending-total").textContent).toBe("0"));
    expect((screen.getByLabelText("Estimate field") as HTMLSelectElement).value).toBe("");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("disables the row for somebody who does not own the project, and greys it out", () => {
    render(<TaskFieldsSection {...props} project={{ ...project, canAdmin: false }} />);
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.className).toContain("disabled:opacity-50");
  });

  it("offers to create a field when the project has no numeric one", () => {
    render(<TaskFieldsSection {...props} project={{ ...project, customFields: noNumericFields }} />);
    expect(screen.queryByLabelText("Estimate field")).toBeNull();
    expect(screen.getByRole("button", { name: /Create .Story points./ })).toBeTruthy();
  });

  it("creates the field and designates it in one action", async () => {
    api.post.mockResolvedValue([{ _id: "f-new", name: "Story points", fieldType: "number" }]);
    render(<TaskFieldsSection {...props} project={{ ...project, customFields: noNumericFields }} />);
    fireEvent.click(screen.getByRole("button", { name: /Create .Story points./ }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/projects/p1/custom-fields", {
        name: "Story points",
        fieldType: "number",
      })
    );
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/projects/p1", { estimateFieldId: "f-new" })
    );
  });

  it("does not designate anything when creating the field fails", async () => {
    api.post.mockRejectedValue(apiError("Field with this name already exists", 409));
    render(<TaskFieldsSection {...props} project={{ ...project, customFields: noNumericFields }} />);
    fireEvent.click(screen.getByRole("button", { name: /Create .Story points./ }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Field with this name already exists", "error")
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("surfaces the error but leaves the new field selectable when the designation save fails after a successful create", async () => {
    api.post.mockResolvedValue([
      ...noNumericFields,
      {
        _id: "f-new",
        name: "Story points",
        fieldType: "number",
        options: [],
        required: false,
        order: noNumericFields.length,
        showOnCard: false,
        showInList: false,
        filterable: false,
        archived: false,
      },
    ]);
    api.put.mockRejectedValue(apiError("Something went wrong", 500));

    render(<Harness initial={{ ...project, customFields: noNumericFields }} />);
    fireEvent.click(screen.getByRole("button", { name: /Create .Story points./ }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Something went wrong", "error"));

    const select = (await screen.findByLabelText("Estimate field")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["None", "Story points"]);
    expect(select.value).toBe("");
  });

  it("clears the local designation, not just the picker's accidental fallback, when the designated field is archived", async () => {
    api.patch.mockResolvedValue([{ ...twoNumericFields[0], archived: true }, twoNumericFields[1]]);

    render(
      <Harness initial={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }} />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);

    await waitFor(() => expect(screen.getByTestId("estimate-field-id").textContent).toBe(""));

    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["None", "Effort"]);
    expect(select.value).toBe("");
  });

  it("leaves the local designation alone when a different field is archived", async () => {
    api.patch.mockResolvedValue([twoNumericFields[0], { ...twoNumericFields[1], archived: true }]);

    render(
      <Harness initial={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }} />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[1]);

    // Once the archive has landed: before it, the assertion below holds whatever the code does
    await waitFor(() => expect(screen.getByText("Effort").closest("div")?.textContent).toMatch(/Archived/));
    expect(screen.getByTestId("estimate-field-id").textContent).toBe(numberFieldId);
    expect((screen.getByLabelText("Estimate field") as HTMLSelectElement).value).toBe(numberFieldId);
  });

  it("clears the local designation when the designated field is deleted", async () => {
    api.del.mockResolvedValue([twoNumericFields[1]]);

    render(
      <Harness initial={{ ...project, customFields: twoNumericFields, estimateFieldId: numberFieldId }} />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete field" }));

    await waitFor(() => expect(screen.getByTestId("estimate-field-id").textContent).toBe(""));

    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["None", "Effort"]);
    expect(select.value).toBe("");
  });
});
