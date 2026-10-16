import { describe, it, expect } from "vitest";
import { toolStatus } from "./tool-status";
import { PM_TOOLS } from "@/lib/pm/tools";

describe("what the chat says a tool is doing", () => {
  it("names the reads as reading, and the writes by phase", () => {
    expect(toolStatus("list_tasks", "running")).toBe("Reading the board…");
    expect(toolStatus("create_task", "preparing")).toBe("Preparing a new task…");
    expect(toolStatus("create_task", "running")).toBe("Applying a new task…");
  });

  it("says something for every tool the PM has, and calls exactly the ones that change nothing reads", () => {
    for (const [name, tool] of Object.entries(PM_TOOLS)) {
      const said = toolStatus(name, "running");
      expect(said, name).not.toContain(name);
      expect(said.startsWith("Reading"), `${name} is ${tool.write ? "a write" : "a read"}`).toBe(!tool.write);
    }
  });

  it("does not show an external server's tool name as if it were the PM's own", () => {
    expect(toolStatus("mcp_notion_search", "running")).toBe("Calling an external tool…");
  });

  it("falls back to the name for a tool it does not know", () => {
    expect(toolStatus("something_new", "running")).toBe("Running something_new…");
  });
});
