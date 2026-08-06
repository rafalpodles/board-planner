// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject, ApiProjectMember } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

function project(over: Partial<ApiProject> = {}): ApiProject {
  return {
    _id: "p1",
    key: "TP",
    name: "Test Project",
    description: "",
    icon: "",
    canAdmin: true,
    ...over,
  } as ApiProject;
}

const members: ApiProjectMember[] = [
  { _id: "u1", username: "alice", fullName: "Alice A", relation: "owner", instanceAdmin: false },
  { _id: "u2", username: "bob", fullName: "", relation: null, instanceAdmin: false },
  { _id: "u3", username: "carol", fullName: "Carol C", relation: null, instanceAdmin: true },
];

function renderSection() {
  return render(
    <SettingsProvider register={vi.fn()} unregister={vi.fn()}>
      <GeneralSection
        projectId="p1"
        project={project()}
        patchProject={vi.fn()}
        replaceProject={vi.fn()}
        isAdmin={false}
        stats={null}
      />
    </SettingsProvider>
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  api.del.mockReset();
  toast.mockReset();
  api.get.mockResolvedValue(members);
  api.put.mockResolvedValue({ ok: true });
  api.del.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("GeneralSection member access", () => {
  it("shows each member's current relation, defaulting an ungranted member to No access", async () => {
    renderSection();

    expect(await screen.findByLabelText("Access for alice")).toHaveProperty("value", "owner");
    expect(screen.getByLabelText("Access for bob")).toHaveProperty("value", "none");
  });

  it("lists an instance admin for reference instead of a select", async () => {
    renderSection();
    await screen.findByLabelText("Access for alice");

    expect(screen.getByText("Instance admin")).toBeTruthy();
    expect(screen.queryByLabelText("Access for carol")).toBeNull();
  });

  it("PUTs the chosen relation when access is granted or changed, not DELETE", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/projects/p1/members", {
        userId: "u2",
        relation: "owner",
      })
    );
    expect(api.del).not.toHaveBeenCalled();
  });

  it("DELETEs the grant when access is revoked, not PUT", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for alice");

    fireEvent.change(select, { target: { value: "none" } });

    await waitFor(() =>
      expect(api.del).toHaveBeenCalledWith("/api/projects/p1/members?userId=u1")
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("refreshes the member list and confirms success after a change lands", async () => {
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(toast).toHaveBeenCalledWith("Access updated", "success");
  });

  it("surfaces the server's last-owner conflict message instead of a generic failure", async () => {
    api.put.mockRejectedValueOnce(new Error("A board must keep at least one owner"));
    renderSection();
    const select = await screen.findByLabelText("Access for bob");

    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("A board must keep at least one owner", "error")
    );
    expect(toast).not.toHaveBeenCalledWith("Failed to update access", "error");
  });
});
