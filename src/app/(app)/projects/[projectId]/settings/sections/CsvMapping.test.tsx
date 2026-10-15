// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { CsvMapping, rememberCsvMapping, type CsvPayload } from "./CsvMapping";
import { readCsvTable } from "@/lib/import/csv";
import type { ApiProject } from "@/types";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const project = {
  columns: [
    { _id: "1", id: "todo", label: "To Do", color: "#000", role: "approved", order: 0, triggersPmReview: false },
    { _id: "2", id: "done", label: "Done", color: "#000", role: "done", order: 1, triggersPmReview: false },
  ],
  customFields: [],
} as unknown as ApiProject;

const table = readCsvTable("ID,Title,Status,Owner,Size\nA-1,One,Open,old.friend,L\n");

function mount(fileName = "q2.csv") {
  const onChange = vi.fn();
  render(<CsvMapping projectId="p1" project={project} table={table} fileName={fileName} disabled={false} onColumns={vi.fn()} onChange={onChange} />);
  const last = () => onChange.mock.calls.at(-1)![0] as CsvPayload | null;
  return { last };
}

beforeEach(() => {
  window.localStorage.clear();
  api.get.mockReset();
  api.get.mockResolvedValue([{ username: "maya" }]);
});

afterEach(cleanup);

describe("CsvMapping", () => {
  it("names the source after the file, never after the file a mapping was remembered from", async () => {
    // As an older version stored it, with the source name
    window.localStorage.setItem(
      `bp:csv-import:p1:${table.headers.map((h) => h.toLowerCase()).join("\u0001")}`,
      JSON.stringify({ targets: ["id", "title", "status", "assignee", "ignore"], statuses: { Open: "done" }, users: {}, source: "q1" })
    );
    const { last } = mount("q2 (3).csv");
    await waitFor(() => expect(last()?.bundle.source).toBe("q2"));
    // The remembered entry was read: its status choice came through
    expect(last()!.mapping.statuses).toEqual({ Open: "done" });
  });

  it("drops a remembered choice that no longer names a field, a column or a member", async () => {
    rememberCsvMapping("p1", table.headers, {
      targets: ["id", "title", "status", "assignee", "field:Size"],
      statuses: { Open: "gone-column" },
      users: { "old.friend": "left-the-board" },
    });
    const { last } = mount();
    await waitFor(() => expect(last()).not.toBeNull());
    expect(last()!.mapping.statuses).toEqual({});
    expect(last()!.bundle.tasks[0]).not.toHaveProperty("fields");
    expect(last()!.mapping.users).toEqual({});
  });

  it("sends a remembered member who is still on the board", async () => {
    rememberCsvMapping("p1", table.headers, {
      targets: ["id", "title", "status", "assignee", "ignore"],
      statuses: {},
      users: { "old.friend": "maya" },
    });
    const { last } = mount();
    await waitFor(() => expect(last()?.mapping.users).toEqual({ "old.friend": "maya" }));
  });

  // Back on the automatic option is no choice at all, so a re-run leaves those tasks where they are
  it("sends nothing for a status put back on No column after picking one", async () => {
    const { last } = mount();
    await waitFor(() => expect(last()).not.toBeNull());
    const select = screen.getByLabelText("Status “Open”");
    fireEvent.change(select, { target: { value: "done" } });
    await waitFor(() => expect(last()!.mapping.statuses).toEqual({ Open: "done" }));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(last()!.mapping.statuses).toEqual({}));
  });
});
