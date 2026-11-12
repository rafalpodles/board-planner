import { describe, expect, it } from "vitest";
import { agentSetupComplete, agentSetupPrompt, agentSetupSteps, type AgentSetupFacts } from "./agent-setup";

const NOTHING: AgentSetupFacts = {
  mcpConnected: false,
  project: null,
  agentName: null,
  machine: "none",
  runsOn: false,
  firstTask: null,
};

const EVERYTHING: AgentSetupFacts = {
  mcpConnected: true,
  project: { key: "PAY", name: "Payments API", repositoryUrl: "https://github.com/acme/api" },
  agentName: "Default",
  machine: "live",
  runsOn: true,
  firstTask: { key: "PAY-1", title: "Add a Running locally section" },
};

const states = (facts: AgentSetupFacts) => agentSetupSteps(facts).map((s) => `${s.key}:${s.state}`);

describe("agentSetupPrompt", () => {
  it("names this organisation's MCP server and connect command, and nothing hard-coded to another", () => {
    const prompt = agentSetupPrompt("https://acme.board-planner.com", "1.14.0");
    expect(prompt).toContain("https://acme.board-planner.com/api/mcp");
    expect(prompt).toContain("--connect 'https://acme.board-planner.com'");
    expect(prompt).not.toContain("app.board-planner.com");
  });

  it("is one prompt that also installs the skill and asks before saving the gates", () => {
    const prompt = agentSetupPrompt("https://x.example.com", "1.14.0");
    expect(prompt).toMatch(/Install the Board Planner skill/);
    expect(prompt).toMatch(/ask me which to keep/);
  });

  it("takes the skill from this release, not from whatever main holds", () => {
    const prompt = agentSetupPrompt("https://x.example.com", "1.14.0");
    expect(prompt).toContain("/tree/v1.14.0/plugins/board-planner/skills/board-planner");
    expect(prompt).not.toContain("/tree/main/");
  });

  it("leaves trusting the Homebrew tap to the person", () => {
    const prompt = agentSetupPrompt("https://x.example.com", "1.14.0");
    expect(prompt).toMatch(/Trusting a third-party Homebrew tap is my decision, so show me this command and ask me to run it/);
    expect(prompt.indexOf("brew tap rafalpodles/tap")).toBeLessThan(prompt.indexOf("brew trust"));
  });
});

describe("agentSetupSteps", () => {
  it("waits on the first row only, before anything happened", () => {
    expect(states(NOTHING)).toEqual(["agent:waiting", "board:todo", "gates:todo", "machine:todo", "task:todo"]);
  });

  it("moves the wait to the first undone row", () => {
    expect(states({ ...NOTHING, mcpConnected: true, project: EVERYTHING.project })).toEqual([
      "agent:done",
      "board:done",
      "gates:waiting",
      "machine:todo",
      "task:todo",
    ]);
  });

  it("does not count a live machine on a board whose runs are off", () => {
    const steps = agentSetupSteps({ ...EVERYTHING, runsOn: false });
    const machine = steps.find((s) => s.key === "machine");
    expect(machine?.state).toBe("waiting");
    expect(machine?.detail).toMatch(/runs are off/);
    expect(agentSetupComplete(steps)).toBe(false);
  });

  it("says why a connected machine is not live yet", () => {
    const machine = agentSetupSteps({ ...EVERYTHING, machine: "unbound" }).find((s) => s.key === "machine");
    expect(machine?.detail).toMatch(/refused its checkout/);
  });

  it("is complete only when every row is read as done", () => {
    expect(agentSetupComplete(agentSetupSteps(EVERYTHING))).toBe(true);
    expect(agentSetupComplete(agentSetupSteps({ ...EVERYTHING, firstTask: null }))).toBe(false);
  });
});
