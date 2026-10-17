import { describe, it, expect } from "vitest";
import { afterEach } from "vitest";
import {
  CAPABILITIES_HEADER,
  capabilities,
  capabilityHeaders,
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
    expect(capabilities()).toEqual([MULTI_REPOSITORY]);
    expect(capabilityHeaders()).toEqual({ "X-CP-Capabilities": "multi-repository" });
  });

  it("sends no header at all once the capability is taken back, so the server hands this worker no such project", () => {
    expect(capabilities(false)).toEqual([]);
    expect(capabilityHeaders(false)).toEqual({});
  });
});

// BP-987. The coding CLIs preflight found usable, named the way the server's claim reads them
describe("what this worker says it can run", () => {
  afterEach(() => reportAgents([]));

  it("says nothing about agents until preflight has looked", () => {
    expect(capabilities()).toEqual([MULTI_REPOSITORY]);
  });

  it("names each usable CLI as agent-<id>, after the capability it already said", () => {
    reportAgents(["claude", "codex"]);

    expect(capabilities()).toEqual(["multi-repository", "agent-claude", "agent-codex"]);
    expect(capabilityHeaders()).toEqual({ "X-CP-Capabilities": "multi-repository,agent-claude,agent-codex" });
  });

  it("says nothing of Codex on a machine that has none", () => {
    reportAgents(["claude"]);

    expect(capabilities()).not.toContain("agent-codex");
  });

  it("keeps saying what the machine can run when the several-repositories capability is taken back", () => {
    reportAgents(["claude", "codex"]);

    expect(capabilities(false)).toEqual(["agent-claude", "agent-codex"]);
  });

  it("stops saying it when the report is emptied, as a restart does", () => {
    reportAgents(["codex"]);
    reportAgents([]);

    expect(capabilities()).toEqual([MULTI_REPOSITORY]);
  });
});
