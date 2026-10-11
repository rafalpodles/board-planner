import { EXECUTION_DOCS_URL } from "@/lib/docs-urls";
import { projectPath } from "@/lib/urls";
import type { SetupGuideGroupId, SetupGuideStepId } from "@/types";

export const GROUP_TITLES: Record<SetupGuideGroupId, string> = {
  board: "Board",
  connections: "Connections",
  ai: "AI",
  agents: "Agents",
  organisation: "Organisation",
};

export interface StepCopy {
  title: string;
  why: string;
  action: string;
  href: (projectRef: string) => string;
  external?: boolean;
}

const settings = (section: string) => (ref: string) => `${projectPath(ref)}/settings?section=${section}`;

export const STEP_COPY: Record<SetupGuideStepId, StepCopy> = {
  tasks: {
    title: "Add your first tasks",
    why: "Fill the board so there is something to move.",
    action: "New task",
    href: (ref) => `${projectPath(ref)}?new=1`,
  },
  team: {
    title: "Invite your team",
    why: "Nobody sees a board until they are added to it.",
    action: "Settings › General",
    href: settings("general"),
  },
  columns: {
    title: "Shape your columns",
    why: "Rename or add columns to match how you really work.",
    action: "Settings › Board",
    href: settings("board"),
  },
  fields: {
    title: "Add categories or fields",
    why: "Track what matters to you: difficulty, component, customer.",
    action: "Settings › Task fields",
    href: settings("fields"),
  },
  sprint: {
    title: "Plan a sprint",
    why: "Time-box a slice of work and watch the burndown.",
    action: "Sprints",
    href: (ref) => `${projectPath(ref)}/sprints`,
  },
  repository: {
    title: "Link a repository",
    why: "Pull requests show up on their tasks, with CI status.",
    action: "Settings › Integrations",
    href: settings("integrations"),
  },
  channel: {
    title: "Pick a team channel",
    why: "Slack or Discord gets the events your team cares about.",
    action: "Settings › Notifications",
    href: settings("notifications"),
  },
  webhook: {
    title: "Add a webhook",
    why: "Send board events to your own systems, signed.",
    action: "Settings › Integrations",
    href: settings("integrations"),
  },
  token: {
    title: "Connect an AI client",
    why: "Let Claude or any MCP client work your board with a token.",
    action: "API tokens",
    href: () => "/settings/tokens",
  },
  pm: {
    title: "Turn on the PM agent",
    why: "A project manager that reviews the board and answers in chat.",
    action: "Settings › PM agent",
    href: settings("pm"),
  },
  aiKey: {
    title: "Add your own AI key",
    why: "Use your own model account for the PM and AI Assist.",
    action: "AI keys",
    href: () => "/settings/ai-keys",
  },
  runs: {
    title: "Allow agent runs",
    why: "Let machines pick up tasks on this board.",
    action: "Settings › Workers",
    href: settings("workers"),
  },
  machine: {
    title: "Connect a machine",
    why: "Install the menubar app and enrol it with one code.",
    action: "How to connect one",
    href: () => `${EXECUTION_DOCS_URL}#setting-one-up`,
    external: true,
  },
  handover: {
    title: "Hand a task to an agent",
    why: "Pick an agent on a task and assign it to yourself.",
    action: "Open the board",
    href: (ref) => projectPath(ref),
  },
  sso: {
    title: "Set up single sign-on",
    why: "People sign in with your own identity provider.",
    action: "Single sign-on",
    href: () => "/settings/sso",
  },
  plan: {
    title: "Choose a plan",
    why: "The trial runs 30 days. Pro keeps single sign-on and managed AI.",
    action: "Plan",
    href: () => "/settings/licence",
  },
};
