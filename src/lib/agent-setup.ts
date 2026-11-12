import type { MachineState } from "@/types";

export const skillSource = (release: string) =>
  `https://github.com/rafalpodles/board-planner/tree/v${release}/plugins/board-planner/skills/board-planner`;
export const WORKER_APP_BINARY = '"/Applications/Board Planner Worker.app/Contents/MacOS/CPMenubar"';

export function agentSetupPrompt(origin: string, release: string): string {
  return [
    "Set up Board Planner for this repository, one step at a time. If a step fails, stop and tell me what failed.",
    "",
    `1. Install the Board Planner skill: copy the folder at ${skillSource(release)} into your own skills folder, outside this repository so it is never committed, and follow it from here on.`,
    `2. Connect the Board Planner MCP server at ${origin}/api/mcp over HTTP. I will approve the sign-in in my browser, giving it every board, because it creates a new one.`,
    "3. Read this repository: its git remote, and the scripts in package.json, a Makefile or the CI configuration. Propose the checks a change must pass before it is pushed, choosing from the gates list_agent_blocks offers, then ask me which to keep. Save nothing before I answer. If the checks are not npm scripts, tell me their commands go in the board's Settings → Workers.",
    "4. Create the board: create_project with repositoryUrl set to this repository's remote address, without any credentials in it, then create_agent for that board out of list_agent_blocks (the step that writes the change, and the gates for the checks I kept), then update_project with that agent as defaultAgent.",
    "5. Connect this Mac. Trusting a third-party Homebrew tap is my decision, so show me this command and ask me to run it:",
    "   brew trust --cask rafalpodles/tap/board-planner-worker",
    "   Once I have, run these, with a long timeout on the last one:",
    "   brew tap rafalpodles/tap",
    "   brew install --cask rafalpodles/tap/board-planner-worker",
    `   ${WORKER_APP_BINARY} --connect '${origin}'`,
    "   It prints a link. Tell me to open it, choose the new board and approve. If the command is stopped while it waits, run it again.",
    "6. Add one small, safe first task to the new board with create_task, based on what you read, with acceptance criteria. Then tell me it is ready to run in Board Planner.",
  ].join("\n");
}

export type SetupStepKey = "agent" | "board" | "gates" | "machine" | "task";
export type SetupStepState = "done" | "waiting" | "todo";

export interface AgentSetupFacts {
  mcpConnected: boolean;
  project: { key: string; name: string; repositoryUrl: string } | null;
  agentName: string | null;
  machine: MachineState;
  runsOn: boolean;
  firstTask: { key: string; title: string } | null;
}

export interface SetupStep {
  key: SetupStepKey;
  state: SetupStepState;
  detail: string;
}

const ORDER: SetupStepKey[] = ["agent", "board", "gates", "machine", "task"];

/** Each row is read from the board, never from what the agent says it did; the first undone row is the one being waited on */
export function agentSetupSteps(facts: AgentSetupFacts): SetupStep[] {
  const done: Record<SetupStepKey, string | null> = {
    agent: facts.mcpConnected ? "Connected over MCP" : null,
    board: facts.project ? `${facts.project.name} (${facts.project.key}) · ${facts.project.repositoryUrl}` : null,
    gates: facts.agentName ? `Default agent: ${facts.agentName}` : null,
    machine: facts.machine === "live" && facts.runsOn ? "Live, and runs are on for this board" : null,
    task: facts.firstTask ? `${facts.firstTask.key} · ${facts.firstTask.title}` : null,
  };
  let waitingGiven = false;
  return ORDER.map((key) => {
    const detail = done[key];
    if (detail !== null) return { key, state: "done", detail };
    const state: SetupStepState = waitingGiven ? "todo" : "waiting";
    waitingGiven = true;
    return { key, state, detail: state === "waiting" ? waitingDetail(key, facts) : "" };
  });
}

function waitingDetail(key: SetupStepKey, facts: AgentSetupFacts): string {
  switch (key) {
    case "agent":
      return "Waiting for your coding agent to connect";
    case "board":
      return "Waiting for the board";
    case "gates":
      return "Your coding agent is asking you which checks to keep";
    case "machine":
      if (facts.machine === "live" && !facts.runsOn) return "This Mac is live, but runs are off for this board";
      if (facts.machine === "unbound") return "This Mac is connected, but its worker refused its checkout of this repository";
      if (facts.machine !== "none") return MACHINE_WAIT[facts.machine];
      return "Waiting for this Mac: approve it when the link opens";
    case "task":
      return "Waiting for the first task";
  }
}

const MACHINE_WAIT: Record<Exclude<MachineState, "none" | "unbound">, string> = {
  live: "This Mac is live",
  disabled: "This Mac is switched off in Settings → Machines",
  stale: "This Mac has not been heard from lately: open Board Planner Worker on it",
  held: "This Mac is beyond your plan's machine limit",
  paused: "This Mac is paused: resume it from the menu bar",
  stopped: "This Mac is stopped: start it from the menu bar",
  failing: "This Mac's checks fail: open Board Planner Worker on it to see why",
};

export function agentSetupComplete(steps: SetupStep[]): boolean {
  return steps.every((step) => step.state === "done");
}
