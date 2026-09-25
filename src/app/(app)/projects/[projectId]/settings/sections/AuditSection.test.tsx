// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { AuditSection } from "./AuditSection";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const entry = {
  _id: "a1",
  action: "settings_updated",
  field: "name",
  oldValue: "Old",
  newValue: "New",
  user: { _id: "u1", username: "owner", fullName: "Owner Name" },
  createdAt: "2026-08-01T00:00:00Z",
};

beforeEach(() => {
  api.get.mockReset();
});

afterEach(cleanup);

describe("AuditSection", () => {
  it("names the user who made the change", async () => {
    api.get.mockResolvedValue([entry]);
    render(<AuditSection projectId="TP" active />);
    await waitFor(() => expect(screen.getByText("owner")).toBeTruthy());
  });

  // BP-742: one line per changed setting, each with its value after the arrow, and none cut off
  it("shows every line of a multi-setting change", async () => {
    api.get.mockResolvedValue([
      { ...entry, detail: "Workers: off → on\nRepository: none → https://github.com/orbit-dev/orbit" },
    ]);
    render(<AuditSection projectId="TP" active />);

    const cell = await screen.findByTestId("audit-detail");
    expect(cell.textContent).toBe(
      "Workers: off → on\nRepository: none → https://github.com/orbit-dev/orbit"
    );
    expect(cell.className).toContain("whitespace-pre-line");
    expect(cell.className).not.toMatch(/\btruncate\b/);
  });

  // typeof null === "object", so a deleted user used to take the populated branch and throw
  it("falls back to system when the user was deleted", async () => {
    api.get.mockResolvedValue([{ ...entry, user: null }]);
    render(<AuditSection projectId="TP" active />);
    await waitFor(() => expect(screen.getByText("system")).toBeTruthy());
  });
});
