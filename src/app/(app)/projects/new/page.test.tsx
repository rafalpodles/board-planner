// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { AuthState } from "@/hooks/use-auth";
import type { ApiUser } from "@/types";

const { api, nav, auth, projectsState } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  projectsState: { projects: [] as { key: string }[], reload: vi.fn() },
  nav: { replace: vi.fn(), back: vi.fn(), push: vi.fn() },
  // Annotated, so a field added to AuthState fails here instead of reaching the component as
  // undefined with the suite green
  auth: {
    user: null as ApiUser | null,
    isAdmin: true as boolean,
    isLoading: false as boolean,
    outage: false as boolean,
    suspended: false as boolean,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    onUnauthorized: vi.fn(),
    noteApiStatus: vi.fn(),
    requestLimit: null,
    noteRequestLimit: vi.fn(),
    noteSuspended: vi.fn(),
  } satisfies AuthState,
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => projectsState }));

const { default: NewProjectPage } = await import("./page");

const SETUP_OK = { pmAvailable: true, pmNeedsPlan: false, pmKeyUnreadable: false, pmLocked: false };

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = true;
  auth.isLoading = false;
  projectsState.projects = [];
  // Unanswered unless a test says otherwise: an answer landing after the test is a state update
  // outside act, and most tests are not about it
  api.get.mockReturnValue(new Promise(() => {}));
});

const PEOPLE = [{ _id: "64b0000000000000000000a1", username: "anna", fullName: "Anna K" }];

function answer(setup: unknown, people: unknown = []) {
  api.get.mockImplementation(async (url: string) => (url === "/api/projects/setup" ? setup : people));
}

afterEach(cleanup);

const nameField = () => screen.getByLabelText("Project Name") as HTMLInputElement;
const keyField = () => screen.getByLabelText("Project Key") as HTMLInputElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const stepHeading = () => screen.getByRole("heading", { level: 2 }).textContent;

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}
function toWorkflow(name = "Orbit") {
  type(nameField(), name);
  fireEvent.click(button(/^Next: Workflow/));
}
function toFields(name?: string) {
  toWorkflow(name);
  fireEvent.click(button("Skip"));
}
function toAccess(name?: string) {
  toFields(name);
  fireEvent.click(button("Skip"));
}
function toReview(name?: string) {
  toAccess(name);
  fireEvent.click(button("Skip"));
}
function lastPost() {
  return api.post.mock.calls.at(-1) as [string, Record<string, unknown>];
}

// BP-534: this page used to read no auth state at all, so a member reached the full form by URL
// and was only refused after posting.
describe("the admin gate", () => {
  it("renders the wizard for an admin", () => {
    render(<NewProjectPage />);

    expect(screen.getByRole("heading", { name: "New project" })).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("sends a non-admin to /projects and renders nothing", () => {
    auth.isAdmin = false;

    render(<NewProjectPage />);

    expect(nav.replace).toHaveBeenCalledWith("/projects");
    expect(screen.queryByRole("heading", { name: "New project" })).toBeNull();
  });

  it("decides nothing while the first answer is outstanding", () => {
    auth.isAdmin = false;
    auth.isLoading = true;

    render(<NewProjectPage />);

    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "New project" })).toBeNull();
  });
});

describe("the key", () => {
  it("is suggested from the name as it is typed", () => {
    render(<NewProjectPage />);

    type(nameField(), "Orbit");
    expect(keyField().value).toBe("ORB");

    type(nameField(), "Orbit Launch");
    expect(keyField().value).toBe("OL");
  });

  it("is never overwritten once the person has typed their own", () => {
    render(<NewProjectPage />);

    type(nameField(), "Orbit");
    type(keyField(), "sat");
    type(nameField(), "Orbit Launch");

    expect(keyField().value).toBe("SAT");
  });

  it("follows the name again after the typed key is cleared", () => {
    render(<NewProjectPage />);

    type(keyField(), "SAT");
    type(keyField(), "");
    type(nameField(), "Orbit");

    expect(keyField().value).toBe("ORB");
  });

  it("says it is permanent, with the task keys it will produce", () => {
    render(<NewProjectPage />);

    type(nameField(), "Orbit");

    expect(keyField().getAttribute("aria-describedby")).toBe("project-key-hint");
    expect(document.getElementById("project-key-hint")?.textContent).toBe(
      "Task keys are built from it (ORB-1, ORB-2…) and it cannot change later."
    );
  });
});

describe("a key another board holds", () => {
  it("is not suggested", () => {
    projectsState.projects = [{ key: "ORB" }];
    render(<NewProjectPage />);

    type(nameField(), "Orbital");

    expect(keyField().value).toBe("ORB2");
  });

  it("is stepped past when the board list arrives after the name was typed", () => {
    const { rerender } = render(<NewProjectPage />);
    type(nameField(), "Orbital");
    expect(keyField().value).toBe("ORB");

    projectsState.projects = [{ key: "ORB" }];
    rerender(<NewProjectPage />);

    expect(keyField().value).toBe("ORB2");
  });

  it("leaves a typed key alone when the board list arrives", () => {
    const { rerender } = render(<NewProjectPage />);
    type(keyField(), "ORB");

    projectsState.projects = [{ key: "ORB" }];
    rerender(<NewProjectPage />);

    expect(keyField().value).toBe("ORB");
  });

  it("is refused on the first step when it is typed anyway, and the wizard does not move on", () => {
    projectsState.projects = [{ key: "ORB" }];
    render(<NewProjectPage />);

    type(nameField(), "Orbital");
    type(keyField(), "orb");

    expect(screen.getByText("ORB is already used by another board.")).toBeTruthy();
    expect(button(/^Next: Workflow/).disabled).toBe(true);
    fireEvent.submit(keyField().closest("form")!);
    expect(stepHeading()).toBe("Basics");
  });

  it("is refused on Review in the server's words when somebody took it in the meantime", async () => {
    api.post.mockRejectedValue(new Error("That key is already used by another board"));
    render(<NewProjectPage />);
    toReview("Orbital");

    fireEvent.click(button("Create Project"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "That key is already used by another board"
    );
    expect(nav.push).not.toHaveBeenCalled();
    expect(stepHeading()).toBe("Review");
  });
});

describe("moving between steps", () => {
  it("holds the person on Basics until there is a name and a key", () => {
    render(<NewProjectPage />);

    expect(button(/^Next: Workflow/).disabled).toBe(true);
    const later = screen.getByRole("button", { name: /^Workflow/ }) as HTMLButtonElement;
    expect(later.disabled).toBe(true);

    type(nameField(), "Orbit");

    expect(button(/^Next: Workflow/).disabled).toBe(false);
    expect(later.disabled).toBe(false);
  });

  it("offers Skip on the optional steps and not on Basics or Review", () => {
    render(<NewProjectPage />);
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();

    toWorkflow();
    expect(stepHeading()).toBe("Workflow");
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();

    fireEvent.click(button("Skip"));
    fireEvent.click(button("Skip"));
    fireEvent.click(button("Skip"));
    expect(stepHeading()).toBe("Review");
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });

  it("keeps what was entered when going back and forward", () => {
    render(<NewProjectPage />);
    toWorkflow("Orbit Launch");

    fireEvent.click(button("Back"));

    expect(nameField().value).toBe("Orbit Launch");
    expect(keyField().value).toBe("OL");
  });

  it("goes to the step an Edit link names", () => {
    render(<NewProjectPage />);
    toReview();

    fireEvent.click(screen.getByRole("button", { name: "Edit Workflow" }));

    expect(stepHeading()).toBe("Workflow");
  });

  it("puts focus on the new step's heading", () => {
    render(<NewProjectPage />);

    toWorkflow();

    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2 }));
  });

  it("Enter in a field moves to the next step, not out of the wizard", () => {
    render(<NewProjectPage />);
    type(nameField(), "Orbit");

    fireEvent.submit(nameField().closest("form")!);

    expect(stepHeading()).toBe("Workflow");
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("the workflow", () => {
  it("starts on Default and shows the role every column carries", () => {
    render(<NewProjectPage />);
    toWorkflow();

    expect((screen.getByRole("radio", { name: /^Default/ }) as HTMLInputElement).checked).toBe(true);
    const roles = screen.getByText("What automation reads").closest("div")!;
    expect(within(roles).getByText("Ready to pick up").closest("div")!.textContent).toContain("To Do");
    expect(within(roles).getByText("Awaiting review").closest("div")!.textContent).toContain("Needs Human Review");
  });

  it("keeps a backlog column in Simple", () => {
    render(<NewProjectPage />);
    toWorkflow();

    fireEvent.click(screen.getByRole("radio", { name: /^Simple/ }));

    const roles = screen.getByText("What automation reads").closest("div")!;
    expect(within(roles).getByText("Ideas & backlog").closest("div")!.textContent).toContain("Backlog");
    expect(within(roles).getByText("Awaiting review").closest("div")!.textContent).toContain("No column");
  });

  it("holds a custom board that loses its Done column, in the server's words", () => {
    render(<NewProjectPage />);
    toWorkflow();
    fireEvent.click(screen.getByRole("radio", { name: /^Custom/ }));

    fireEvent.click(screen.getByRole("button", { name: "Remove Done" }));

    expect(screen.getByRole("alert").textContent).toMatch(/needs a column meaning Done/);
    expect(button(/^Next: Task fields/).disabled).toBe(true);
  });

  it("adds a column to a custom board, in the role it is given", () => {
    api.post.mockResolvedValue({ key: "ORB" });
    render(<NewProjectPage />);
    toWorkflow();
    fireEvent.click(screen.getByRole("radio", { name: /^Custom/ }));

    type(screen.getByLabelText("New column name"), "QA");
    fireEvent.click(button("Add column"));
    fireEvent.change(screen.getByLabelText("Role for QA"), { target: { value: "review" } });

    expect(screen.getAllByLabelText("Column name").map((i) => (i as HTMLInputElement).value)).toEqual([
      "Backlog",
      "To Do",
      "In Progress",
      "Done",
      "QA",
    ]);
    expect((screen.getByLabelText("Role for QA") as HTMLSelectElement).value).toBe("review");
  });
});

describe("the task fields", () => {
  it("opens with the default categories kept", () => {
    render(<NewProjectPage />);
    toFields();

    const group = screen.getByRole("group", { name: "Categories to start with" });
    expect(within(group).getByRole("button", { name: "Keep defaults" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("user-story")).toBeTruthy();
  });

  it("adds components inline and refuses the same name twice", () => {
    render(<NewProjectPage />);
    toFields();

    const group = screen.getByRole("group", { name: "Components to start with" });
    fireEvent.click(within(group).getByRole("button", { name: "Add a few" }));
    type(screen.getByLabelText("New component"), "api");
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);
    type(screen.getByLabelText("New component"), "API");
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

    expect(screen.getAllByText("api")).toHaveLength(1);
  });
});

describe("automation and access", () => {
  it("offers the PM switch when an agent could run", async () => {
    answer(SETUP_OK);
    render(<NewProjectPage />);
    toAccess();

    expect(await screen.findByRole("switch", { name: /PM agent/ })).toBeTruthy();
  });

  it("explains instead of offering it when the instance has no key", async () => {
    answer({ ...SETUP_OK, pmAvailable: false });
    render(<NewProjectPage />);
    toAccess();

    await waitFor(() => expect(screen.getByText(/needs a model key/)).toBeTruthy());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("searches only from two letters, and adds a person as a member", async () => {
    answer(SETUP_OK, PEOPLE);
    render(<NewProjectPage />);
    toAccess();
    const search = await screen.findByRole("combobox");

    type(search, "a");
    await new Promise((r) => setTimeout(r, 300));
    expect(api.get.mock.calls.some(([url]) => String(url).includes("setup/people"))).toBe(false);

    type(search, "an");
    fireEvent.click(await screen.findByRole("option", { name: /Anna K/ }));

    expect((screen.getByLabelText("Access for anna") as HTMLSelectElement).value).toBe("member");
    expect(api.get).toHaveBeenCalledWith("/api/projects/setup/people?q=an");
  });

  it("does not offer a person who is already on the list", async () => {
    answer(SETUP_OK, PEOPLE);
    render(<NewProjectPage />);
    toAccess();
    const search = await screen.findByRole("combobox");
    type(search, "an");
    fireEvent.click(await screen.findByRole("option", { name: /Anna K/ }));

    type(search, "an");

    expect(await screen.findByText("Already on the list")).toBeTruthy();
  });
});

describe("creating the project", () => {
  it("sends only the basics when the person clicked straight through, as the old form did", async () => {
    api.post.mockResolvedValue({ key: "ORB" });
    render(<NewProjectPage />);
    toReview();

    fireEvent.click(button("Create Project"));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/projects/ORB"));
    const [url, body] = lastPost();
    expect(url).toBe("/api/projects");
    expect(Object.keys(body).sort()).toEqual(["description", "icon", "key", "name"]);
    expect(body).toMatchObject({ name: "Orbit", key: "ORB" });
  });

  it("sends the preset, the fields and the people that were chosen", async () => {
    answer(SETUP_OK, PEOPLE);
    api.post.mockResolvedValue({ key: "ORB" });
    render(<NewProjectPage />);
    toWorkflow();
    fireEvent.click(screen.getByRole("radio", { name: /^Simple/ }));
    fireEvent.click(button("Skip"));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Categories to start with" })).getByRole("button", {
        name: "Start empty",
      })
    );
    fireEvent.click(button("Skip"));
    type(screen.getByLabelText("Repository URL"), "https://github.com/acme/orbit");
    fireEvent.click(await screen.findByRole("switch", { name: /PM agent/ }));
    type(screen.getByRole("combobox"), "an");
    fireEvent.click(await screen.findByRole("option", { name: /Anna K/ }));
    fireEvent.change(screen.getByLabelText("Access for anna"), { target: { value: "owner" } });
    fireEvent.click(button("Skip"));

    fireEvent.click(button("Create Project"));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, body] = lastPost();
    expect(body.columns).toEqual([
      { label: "Backlog", role: "backlog", color: "#6b7280", triggersPmReview: false },
      { label: "To Do", role: "approved", color: "#3b82f6", triggersPmReview: false },
      { label: "In Progress", role: "active", color: "#f59e0b", triggersPmReview: false },
      { label: "Done", role: "done", color: "#22c55e", triggersPmReview: false },
    ]);
    expect(body.categories).toEqual([]);
    expect(body.repositoryUrl).toBe("https://github.com/acme/orbit");
    expect(body.pm).toEqual({ enabled: true });
    expect(body.access).toEqual([{ userId: "64b0000000000000000000a1", relation: "owner" }]);
  });

  // BP-1035: the sidebar reads its list once, so a board made here was missing from it until a reload
  it("re-reads the project list before it opens the board", async () => {
    const order: string[] = [];
    api.post.mockResolvedValue({ key: "ORB" });
    projectsState.reload.mockImplementation(async () => {
      order.push("reload");
    });
    nav.push.mockImplementation(() => order.push("push"));
    render(<NewProjectPage />);
    toReview();

    fireEvent.click(button("Create Project"));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/projects/ORB"));
    expect(order).toEqual(["reload", "push"]);
  });

  it("leaves the list alone and says nothing was saved when the create is refused", async () => {
    api.post.mockRejectedValue(new Error("Key taken"));
    render(<NewProjectPage />);
    toReview();

    fireEvent.click(button("Create Project"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Key taken");
    expect(alert.textContent).toContain("Nothing was saved");
    expect(projectsState.reload).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("cannot be created from Review while the custom board is broken", () => {
    render(<NewProjectPage />);
    toWorkflow();
    fireEvent.click(screen.getByRole("radio", { name: /^Custom/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Done" }));
    fireEvent.click(screen.getByRole("button", { name: /^Review/ }));

    expect(button("Create Project").disabled).toBe(true);
    fireEvent.submit(button("Create Project").closest("form")!);
    expect(api.post).not.toHaveBeenCalled();
  });
});
