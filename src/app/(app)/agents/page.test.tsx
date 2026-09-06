// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const isAdmin = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAdmin: isAdmin.value, onUnauthorized: vi.fn(), noteApiStatus: vi.fn() }),
}));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => ({ projects: [] }) }));
vi.mock("./store", () => ({
  useStore: () => ({
    loading: false,
    allAgents: [],
    allSteps: [],
    allGates: [],
    addAgent: vi.fn(),
    addBlock: vi.fn(),
    updateBlock: vi.fn(),
    removeBlock: vi.fn(),
    removeAgent: vi.fn(),
  }),
}));

const { default: AgentsPage } = await import("./page");

afterEach(() => {
  cleanup();
  isAdmin.value = true;
});

async function openTab(label: string) {
  render(<AgentsPage />);
  const tab = screen.getAllByRole("tab").find((t) => t.textContent === label);
  await act(async () => tab!.click());
}

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
    expect(screen.getByText(/instance admin authors/i)).not.toBeNull();
  });

  it.each(["Gates", "Steps"])("offers the %s action to an instance admin", async (tab) => {
    await openTab(tab);

    const name = `New ${tab.toLowerCase().slice(0, -1)}`;
    expect(screen.queryByRole("button", { name })).not.toBeNull();
    expect(screen.queryByText(/instance admin authors/i)).toBeNull();
  });
});
