// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ImportSection } from "./ImportSection";
import type { ApiProject } from "@/types";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn() } }));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const BUNDLE = JSON.stringify({ source: "Script", tasks: [{ id: "1", title: "One" }] });
const CHECKED = {
  dryRun: true,
  source: "Script",
  total: 1,
  processed: 1,
  created: 1,
  updated: 0,
  links: 0,
  comments: { created: 0, updated: 0 },
  skipped: [],
  dropped: [],
  truncated: [],
  notImported: [],
  unmapped: { statuses: [], users: [], types: [] },
};

async function choose() {
  render(<ImportSection projectId="p1" project={{} as ApiProject} patchProject={vi.fn()} />);
  const file = new File([BUNDLE], "bundle.json", { type: "application/json" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(BUNDLE).buffer });
  fireEvent.change(screen.getByLabelText(/Import file/), { target: { files: [file] } });
  await screen.findByText("Check first. Import opens once the check has passed.");
}

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => api.post.mockReset());
afterEach(cleanup);

describe("ImportSection", () => {
  // A proxy's 5xx has no JSON, and over HTTP/2 no status text to make a message of
  it("says a Check failed when the failure has no message of its own", async () => {
    await choose();
    api.post.mockRejectedValueOnce(new Error(""));
    press("Check");
    expect((await screen.findByRole("alert")).textContent).toBe("The import could not run");
    expect(screen.getByText("Check again to import.")).toBeTruthy();
  });

  it("says an Import failed the same way, and offers the Check again", async () => {
    await choose();
    api.post.mockResolvedValueOnce(CHECKED);
    press("Check");
    await screen.findByTestId("import-report");
    api.post.mockRejectedValueOnce(new Error(""));
    press("Import");
    expect((await screen.findByRole("alert")).textContent).toBe("The import could not run");
    expect(screen.getByText("Check again to import.")).toBeTruthy();
  });

  it("offers nothing more once the import is done", async () => {
    await choose();
    api.post.mockResolvedValueOnce(CHECKED);
    press("Check");
    await screen.findByText(/Would create/);
    api.post.mockResolvedValueOnce({ ...CHECKED, dryRun: false });
    press("Import");
    await screen.findByText(/^Created/);
    expect(screen.queryByText("Check again to import.")).toBeNull();
    expect(screen.queryByText(/Check first/)).toBeNull();
  });
});
