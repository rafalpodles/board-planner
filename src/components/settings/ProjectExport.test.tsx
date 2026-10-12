// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ProjectExport } from "./ProjectExport";

const assign = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const press = () => fireEvent.click(screen.getByRole("button", { name: "Download the project export" }));

describe("the project export button (BP-1011)", () => {
  it("checks the export is allowed, then starts the download", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    render(<ProjectExport projectId="p1" projectName="Rockets" />);

    press();

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/projects/p1/export"));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/export?check=1");
  });

  it("says why on the page when the export is refused, and saves nothing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({ error: "Interactive session required" }) });
    render(<ProjectExport projectId="p1" projectName="Rockets" />);

    press();

    expect((await screen.findByTestId("project-export-error")).textContent).toContain("Interactive session required");
    expect(assign).not.toHaveBeenCalled();
  });

  it("says so when the request never got an answer", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<ProjectExport projectId="p1" projectName="Rockets" />);

    press();

    expect((await screen.findByTestId("project-export-error")).textContent).toContain("could not be started");
    expect(assign).not.toHaveBeenCalled();
  });

  it("names the project in what it offers", () => {
    render(<ProjectExport projectId="p1" projectName="Rockets" />);

    expect(screen.getByText(/Rockets in one file/)).toBeTruthy();
  });
});
