import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { buildSystemPrompt } = await import("./agent");

const mcp = { tools: new Map(), serverNames: [] };

const project = {
  _id: "p1",
  name: "Board Planner",
  key: "BP",
  categories: [{ name: "bug" }],
  customFields: [],
  columns: [],
};

const rafal = { username: "rafal", fullName: "Rafal Podles", isAgent: false };

function prompt(actor: typeof rafal | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return buildSystemPrompt(project as any, mcp as never, [], actor as never);
}

describe("the PM agent's system prompt", () => {
  it("names who is speaking, with their handle", () => {
    expect(prompt(rafal)).toContain("Rafal Podles (@rafal)");
  });

  /**
   * "Make a task and assign it to me" has to reach a tool call carrying a username, and the tools
   * take usernames rather than "me". Naming somebody and resolving "me" to them are different
   * inferences; this is the second one, said out loud rather than left to the model.
   */
  it("says what 'me' resolves to, so a self-assignment needs no follow-up question", () => {
    expect(prompt(rafal)).toMatch(/"me".*mean.*@rafal/);
  });

  /** An autonomous turn has no human behind it, and nothing it could resolve "me" to. */
  it("resolves nothing for an automated turn", () => {
    const automated = prompt({ username: "pm", fullName: "PM Agent", isAgent: true });
    expect(automated).toContain("This turn is automated");
    expect(automated).not.toMatch(/"me".*mean/);
  });
});
