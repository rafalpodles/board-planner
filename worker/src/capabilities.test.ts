import { describe, it, expect } from "vitest";
import { afterEach } from "vitest";
import {
  CAPABILITIES_HEADER,
  capabilities,
  capabilityHeaders,
  GATE_COMMANDS,
  MULTI_REPOSITORY,
  reportAgents,
  SAYS_IT_RUNS_SEVERAL_REPOSITORIES,
} from "./capabilities.js";

// BP-1073. Said only once a real worker has carried a task through two repositories in CI; said
// earlier, the first project that lists several would be handed to a worker nobody has watched run one.
describe("what this worker says it can do", () => {
  it("names the capability the server looks for, spelt the way the server spells it", () => {
    expect(MULTI_REPOSITORY).toBe("multi-repository");
    expect(CAPABILITIES_HEADER).toBe("X-CP-Capabilities");
  });

  it("says it runs several repositories", () => {
    expect(SAYS_IT_RUNS_SEVERAL_REPOSITORIES).toBe(true);
    expect(capabilities()).toEqual([GATE_COMMANDS, MULTI_REPOSITORY]);
    expect(capabilityHeaders()).toEqual({ "X-CP-Capabilities": "gate-commands,multi-repository" });
  });

  it("takes back only that capability, so the server hands this worker no such project", () => {
    expect(capabilities(false)).toEqual([GATE_COMMANDS]);
    expect(capabilityHeaders(false)).toEqual({ "X-CP-Capabilities": "gate-commands" });
  });
});

// BP-987. The coding CLIs preflight found usable, named the way the server's claim reads them
describe("what this worker says it can run", () => {
  afterEach(() => reportAgents([]));

  it("says nothing about agents until preflight has looked", () => {
    expect(capabilities()).toEqual([GATE_COMMANDS, MULTI_REPOSITORY]);
  });

  it("names each usable CLI as agent-<id>, after the capability it already said", () => {
    reportAgents(["claude", "codex"]);

    expect(capabilities()).toEqual([GATE_COMMANDS, "multi-repository", "agent-claude", "agent-codex"]);
    expect(capabilityHeaders()).toEqual({ "X-CP-Capabilities": "gate-commands,multi-repository,agent-claude,agent-codex" });
  });

  it("says nothing of Codex on a machine that has none", () => {
    reportAgents(["claude"]);

    expect(capabilities()).not.toContain("agent-codex");
  });

  it("keeps saying what the machine can run when the several-repositories capability is taken back", () => {
    reportAgents(["claude", "codex"]);

    expect(capabilities(false)).toEqual([GATE_COMMANDS, "agent-claude", "agent-codex"]);
  });

  it("stops saying it when the report is emptied, as a restart does", () => {
    reportAgents(["codex"]);
    reportAgents([]);

    expect(capabilities()).toEqual([GATE_COMMANDS, MULTI_REPOSITORY]);
  });

  it("stops claiming a CLI the moment it is no longer usable, without waiting for a new preflight", () => {
    let codexIsThere = true;
    reportAgents(["claude", "codex"], (agent) => agent !== "codex" || codexIsThere);
    expect(capabilities()).toContain("agent-codex");

    codexIsThere = false;

    expect(capabilities()).toEqual([GATE_COMMANDS, "multi-repository", "agent-claude"]);
    expect(capabilityHeaders()).toEqual({ "X-CP-Capabilities": "gate-commands,multi-repository,agent-claude" });
  });

  it("claims it again when it comes back", () => {
    let codexIsThere = false;
    reportAgents(["codex"], () => codexIsThere);
    expect(capabilities()).not.toContain("agent-codex");

    codexIsThere = true;

    expect(capabilities()).toContain("agent-codex");
  });
});
