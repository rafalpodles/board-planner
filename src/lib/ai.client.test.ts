import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => [] as Record<string, unknown>[]);
const create = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  },
}));

const { generateTask } = await import("./ai");

const CONTEXT = { name: "Board", description: "", choiceFields: [] };

beforeEach(() => {
  constructed.length = 0;
  create.mockReset();
  create.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ title: "T", description: "d", category: "bug", acceptanceCriteria: "" }) } }],
  });
});

// BP-652. The SDK reads the operator's OpenAI organisation and project from the environment unless told not to,
// and those belong to the operator's key, not to one an organisation brought
describe("the client generateTask makes", () => {
  it("is made with the key it is given", async () => {
    await generateTask("a task", CONTEXT, "m", "sk-given");

    expect(constructed).toEqual([{ apiKey: "sk-given" }]);
  });

  it("is told not to inherit the operator's organisation and project for a key the organisation brought", async () => {
    await generateTask("a task", CONTEXT, "m", "sk-own", true);

    expect(constructed).toEqual([{ apiKey: "sk-own", organization: null, project: null }]);
  });
});
