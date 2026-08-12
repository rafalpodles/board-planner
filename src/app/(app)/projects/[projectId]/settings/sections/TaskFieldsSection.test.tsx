// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TaskFieldsSection } from "./TaskFieldsSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiCustomField, ApiProject } from "@/types";
import { SectionProps } from "./types";

const { api, toast } = vi.hoisted(() => ({
  api: { post: vi.fn(), put: vi.fn() },
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

const numberFieldId = "f-number";

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

let props: SectionProps;

beforeEach(() => {
  api.post.mockReset();
  api.put.mockReset();
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

describe("TaskFieldsSection estimate field", () => {
  it("lists only the project's non-archived numeric fields, and None", async () => {
    render(<TaskFieldsSection {...props} />);
    const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["None", "Story points"]);
  });

  it("saves the designation on the project", async () => {
    render(<TaskFieldsSection {...props} />);
    fireEvent.change(screen.getByLabelText("Estimate field"), { target: { value: numberFieldId } });
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/projects/p1", { estimateFieldId: numberFieldId })
    );
  });

  it("disables the row for somebody who does not own the project", () => {
    render(<TaskFieldsSection {...props} project={{ ...project, canAdmin: false }} />);
    expect((screen.getByLabelText("Estimate field") as HTMLSelectElement).disabled).toBe(true);
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
    api.post.mockRejectedValue({ status: 409 });
    render(<TaskFieldsSection {...props} project={{ ...project, customFields: noNumericFields }} />);
    fireEvent.click(screen.getByRole("button", { name: /Create .Story points./ }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(api.put).not.toHaveBeenCalled();
  });
});
