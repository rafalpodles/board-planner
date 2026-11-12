import { describe, it, expect, vi, beforeEach } from "vitest";

const projectFindOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findOne: projectFindOne } }));

const { handoverVerdict } = await import("./handover-verdict");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const db = scopedToDefaultOrganisation();

const COLUMNS = [
  { id: "todo", label: "To do", color: "#000", role: "approved", order: 0 },
  { id: "doing", label: "Doing", color: "#000", role: "active", order: 1 },
  { id: "check", label: "Check", color: "#000", role: "review", order: 2 },
  { id: "done", label: "Done", color: "#000", role: "done", order: 3 },
];
const BARTEK = { _id: "u-bartek", username: "bartek", fullName: "Bartek" };
const ANIA = { _id: "u-ania", username: "ania", fullName: "Ania" };
const PM = { _id: "u-pm", username: "pm", fullName: "PM" };
const SOUND = { agent: "a1", status: "todo", assignee: BARTEK, assignedBy: BARTEK };

beforeEach(() => {
  projectFindOne.mockReset().mockImplementation(() => ({
    lean: async () => ({ key: "BP", columns: COLUMNS, worker: { enabled: true }, repositoryUrl: "https://github.com/acme/bp" }),
  }));
});

const verdict = (task: Record<string, unknown>) => handoverVerdict(db, "p1", { ...SOUND, ...task });

/** BP-420. Every reason a hand-over waits on its assignee names who has to accept, and where. */
describe("handoverVerdict", () => {
  it("finds nothing in the way of a task its assignee handed to themselves", async () => {
    expect(await verdict({})).toEqual({ willRun: true });
  });

  it("names the assignee who has to accept a colleague's hand-over", async () => {
    expect(await verdict({ assignedBy: ANIA })).toEqual({
      willRun: false,
      why: "it waits for @bartek to accept it in the app — a machine runs work somebody else handed over only once its owner accepts it",
    });
  });

  it("names them for a PM hand-over made on somebody else's instruction", async () => {
    expect(await verdict({ assignedBy: PM, pmAssignedFor: "u-ania" })).toEqual({
      willRun: false,
      why: "it was handed over on somebody else's instruction, so it waits for @bartek to accept it in the app",
    });
  });

  it("and for a task stored before the board recorded who handed work over", async () => {
    expect(await verdict({ assignedBy: null })).toEqual({
      willRun: false,
      why: "the board has no record of who handed it over, so it waits for @bartek to accept it in the app",
    });
  });

  it("says the assignee rather than a name it does not have", async () => {
    expect(await verdict({ assignee: "u-bartek", assignedBy: null })).toMatchObject({
      why: expect.stringContaining("waits for its assignee to accept it"),
    });
  });

  it("joins the board's own gaps to the task's", async () => {
    projectFindOne.mockImplementation(() => ({
      lean: async () => ({ key: "BP", columns: COLUMNS, worker: { enabled: false }, repositoryUrl: "https://github.com/acme/bp" }),
    }));

    expect(await verdict({ assignedBy: ANIA })).toMatchObject({
      why: expect.stringMatching(/to accept it in the app.*; and this project is not enabled for workers/),
    });
  });
});
