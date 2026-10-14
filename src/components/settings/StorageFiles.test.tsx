// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { StorageFiles } from "./StorageFiles";

const { api, toast } = vi.hoisted(() => ({ api: { get: vi.fn(), del: vi.fn() }, toast: vi.fn() }));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const MB = 1024 * 1024;
type Row = { id: string; name: string; size: number; uploadedAt: string; project: { key: string; name: string } | null; uploadedBy: string | null };
const FILE: Row = { id: "f1", name: "plan.pdf", size: 5 * MB, uploadedAt: "2026-10-01T10:00:00.000Z", project: { key: "TP", name: "Test Project" }, uploadedBy: "ola" };

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

async function open(listing: { total: number; files: Row[] } = { total: 1, files: [FILE] }) {
  api.get.mockResolvedValue(listing);
  const onDeleted = vi.fn();
  render(<StorageFiles onDeleted={onDeleted} />);
  fireEvent.click(screen.getByTestId("storage-files-toggle"));
  await screen.findAllByTestId("storage-file").catch(() => undefined);
  return onDeleted;
}

describe("the largest files on the organisation page (BP-1025)", () => {
  it("reads nothing until it is opened, then lists each file with its size, board and uploader", async () => {
    api.get.mockResolvedValue({ total: 1, files: [FILE] });
    render(<StorageFiles onDeleted={vi.fn()} />);
    expect(api.get).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("storage-files-toggle"));
    const row = await screen.findByTestId("storage-file");

    expect(api.get).toHaveBeenCalledWith("/api/organisation/storage/files");
    expect(row.textContent).toContain("plan.pdf");
    expect(row.textContent).toContain("5 MB");
    expect(row.textContent).toContain("Test Project");
    expect(row.textContent).toContain("by ola");
  });

  it("shows a small file at its own size, and says plainly when it does not know who uploaded it", async () => {
    await open({ total: 1, files: [{ ...FILE, name: "tiny.png", size: 70, uploadedBy: null }] });

    const row = await screen.findByTestId("storage-file");
    expect(row.textContent).toContain("70 B");
    expect(row.textContent).toContain("uploader unknown");
  });

  it("says how many of the files it shows when there are more than it lists", async () => {
    await open({ total: 40, files: [FILE] });

    expect(await screen.findByText(/The 1 largest of 40 files\./)).toBeTruthy();
  });

  it("asks before deleting, deletes the file, and tells the page so it can read the usage again", async () => {
    const onDeleted = await open();
    api.del.mockResolvedValue({ freedBytes: 5 * MB });
    api.get.mockResolvedValue({ total: 0, files: [] });

    fireEvent.click(screen.getByRole("button", { name: "Delete plan.pdf" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("This frees 5 MB");
    expect(api.del).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/api/organisation/storage/files/f1"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("storage-files-empty")).toBeTruthy();
  });

  it("keeps the file in the list and says so when the delete fails", async () => {
    const onDeleted = await open();
    api.del.mockRejectedValue(new Error("File not found"));

    fireEvent.click(screen.getByRole("button", { name: "Delete plan.pdf" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("File not found", "error"));
    expect(onDeleted).not.toHaveBeenCalled();
    // Another administrator may have got there first, so the list is read again rather than trusted
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says it could not read the list rather than showing an empty one", async () => {
    api.get.mockRejectedValue(new Error("boom"));
    render(<StorageFiles onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByTestId("storage-files-toggle"));

    expect(await screen.findByTestId("storage-files-error")).toBeTruthy();
    expect(screen.queryByTestId("storage-files-empty")).toBeNull();
  });
});
