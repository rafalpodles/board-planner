// TODO(BP-331): placeholder catalog until the API exists — UI first, backend after.
// Kinds mirror what worker/src implements today. A gate or step defined here is a named
// configuration of a kind, never new executable code.

export type BlockKind = "step" | "gate";

export interface ParamSpec {
  key: string;
  label: string;
  type: "number" | "text" | "select";
  hint?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

export interface GateKind {
  key: string;
  name: string;
  description: string;
  params: ParamSpec[];
}

export const GATE_KINDS: GateKind[] = [
  {
    key: "diff-size",
    name: "Size",
    description: "Refuses a change larger than the limit.",
    params: [
      { key: "maxLines", label: "Most lines", type: "number", placeholder: "400" },
      { key: "maxFiles", label: "Most files", type: "number", placeholder: "10" },
    ],
  },
  {
    key: "protected-paths",
    name: "Protected files",
    description: "Refuses a change to files a later step runs, or loads as its own instructions.",
    params: [
      {
        key: "extraPaths",
        label: "Also protect",
        type: "text",
        placeholder: "infra/, deploy.sh",
        hint: "Added to the built-in list. Nothing can be taken off it.",
      },
    ],
  },
  {
    key: "test-presence",
    name: "Test written",
    description: "Refuses code that came without a test.",
    params: [
      {
        key: "extraPatterns",
        label: "Also count as a test",
        type: "text",
        placeholder: "*.spec.py",
        hint: "Widens what counts. It cannot narrow it.",
      },
    ],
  },
  { key: "build", name: "Builds", description: "Installs dependencies and builds the project.", params: [] },
  { key: "test-run", name: "Tests pass", description: "Runs the whole suite.", params: [] },
  {
    key: "review",
    name: "Reviewed",
    description: "A second model reads the change with no memory of writing it.",
    params: [
      {
        key: "focus",
        label: "Looking for",
        type: "select",
        options: [
          { value: "general", label: "Anything wrong" },
          { value: "security", label: "Security" },
          { value: "acceptance", label: "Acceptance criteria" },
        ],
      },
      {
        key: "model",
        label: "Model",
        type: "select",
        options: [
          { value: "opus", label: "Opus" },
          { value: "sonnet", label: "Sonnet" },
        ],
      },
    ],
  },
];

// What a step may touch. Owned by the worker: the UI picks one, it cannot compose a new one.
export const CAPABILITIES = [
  { value: "read-only", label: "Read only", hint: "Can read the repository. Cannot change anything." },
  { value: "edit", label: "Read and write", hint: "Can change files. The worker commits afterwards." },
] as const;

export interface Block {
  key: string;
  kind: BlockKind;
  name: string;
  description: string;
  builtIn: boolean;
  /** gate only */
  gateKind?: string;
  params?: Record<string, string>;
  /** step only */
  prompt?: string;
  capability?: string;
  model?: string;
  fallbackModel?: string;
  /** A worker action rather than a model call: no prompt, no session, no cost. */
  deterministic?: boolean;
}

export const MODELS = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
] as const;

export const DEFAULT_STEPS: Block[] = [
  {
    key: "implement",
    kind: "step",
    name: "Implement",
    description: "Reads the task, makes the change, writes a test for it.",
    builtIn: true,
    capability: "edit",
    model: "opus",
    fallbackModel: "sonnet",
    prompt: "Make the change the task describes, add or update a test covering it, keep the diff minimal.",
  },
  {
    key: "push",
    kind: "step",
    name: "Push",
    description: "Pushes the branch, so a human can reach the work.",
    builtIn: true,
    deterministic: true,
  },
  {
    key: "pull-request",
    kind: "step",
    name: "Pull request",
    description: "Opens the pull request.",
    builtIn: true,
    deterministic: true,
  },
  {
    key: "merge",
    kind: "step",
    name: "Merge",
    description: "Merges the pull request. Leave it out and a human decides.",
    builtIn: true,
    deterministic: true,
  },
];

// The values that used to live on the project's worker policy. They describe a check, so they
// belong to the check — a project reading 400 in one place and an agent carrying it in another
// gave one decision two homes and no rule for which won.
const DEFAULT_PARAMS: Record<string, Record<string, string>> = {
  "diff-size": { maxLines: "400", maxFiles: "10" },
  review: { focus: "general", model: "opus" },
};

export const DEFAULT_GATES: Block[] = GATE_KINDS.map((k) => ({
  key: k.key,
  kind: "gate" as const,
  name: k.name,
  description: k.description,
  builtIn: true,
  gateKind: k.key,
  params: DEFAULT_PARAMS[k.key] ?? {},
}));

export const DEFAULT_BLOCKS: Block[] = [...DEFAULT_STEPS, ...DEFAULT_GATES];

export function gateKindByKey(key: string): GateKind | undefined {
  return GATE_KINDS.find((k) => k.key === key);
}

export function blockByKey(key: string): Block | undefined {
  return DEFAULT_BLOCKS.find((b) => b.key === key);
}

export const BUCKETS = [
  { id: "analysis", label: "Analysis", hint: "Before anything is written" },
  { id: "implementation", label: "Implementation", hint: "Making the change" },
  { id: "verification", label: "Verification", hint: "Judging what was written" },
  { id: "delivery", label: "Delivery", hint: "Sending it somewhere a human can reach" },
] as const;

export type BucketId = (typeof BUCKETS)[number]["id"];

export type Composition = Record<BucketId, string[]>;

export interface Agent {
  id: string;
  name: string;
  description: string;
  scope: "global" | "mine" | "project";
  projectId?: string;
  projectName?: string;
  composition: Composition;
}

export const SEEDED_AGENTS: Agent[] = [
  {
    id: "default",
    name: "Default",
    description: "What a worker does today: writes the change, then every check below.",
    scope: "global",
    composition: {
      analysis: [],
      implementation: ["implement"],
      verification: [
        "diff-size",
        "protected-paths",
        "test-presence",
        "build",
        "test-run",
        "review",
      ],
      delivery: ["push", "pull-request"],
    },
  },
  {
    id: "with-security-review",
    name: "With security review",
    description: "The same, plus a second model reading the change for security before delivery.",
    scope: "global",
    composition: {
      analysis: [],
      implementation: ["implement"],
      verification: [
        "diff-size",
        "protected-paths",
        "test-presence",
        "build",
        "test-run",
        "review",
      ],
      delivery: ["push", "pull-request"],
    },
  },
];

export function emptyComposition(): Composition {
  return { analysis: [], implementation: [], verification: [], delivery: [] };
}
