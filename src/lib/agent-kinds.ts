// Deliberately free of imports: the settings form renders these in the browser and the seed builds
// the catalog rows from them on the server. Same reasoning as worker-policy.ts — one list, so the
// form and the seeded row cannot drift.

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
  /** What a gate of this kind is seeded with, and what a new one starts from. */
  defaults: Record<string, string>;
}

export const MODELS = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
] as const;

export const GATE_KINDS: GateKind[] = [
  {
    key: "diff-size",
    name: "Size",
    description: "Refuses a change larger than the limit.",
    params: [
      { key: "maxLines", label: "Most lines", type: "number", placeholder: "400" },
      { key: "maxFiles", label: "Most files", type: "number", placeholder: "10" },
    ],
    defaults: { maxLines: "400", maxFiles: "10" },
  },
  {
    key: "protected-paths",
    name: "Protected files",
    description: "Refuses a change to files a later step runs, or loads as its own instructions.",
    // A parameter listed here is one the worker reads. "Also protect" and "Also count as a test"
    // were offered before either gate could act on them, which is a form the operator fills in and
    // nothing obeys — worse than not offering it. They come back with the gates (BP-343).
    params: [],
    defaults: {},
  },
  {
    key: "test-presence",
    name: "Test written",
    description: "Refuses code that came without a test.",
    params: [],
    defaults: {},
  },
  {
    key: "build",
    name: "Builds",
    description: "Installs dependencies and builds the project.",
    params: [],
    defaults: {},
  },
  {
    key: "test-run",
    name: "Tests pass",
    description: "Runs the whole suite.",
    params: [],
    defaults: {},
  },
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
      { key: "model", label: "Model", type: "select", options: [...MODELS] },
    ],
    defaults: { focus: "general", model: "opus" },
  },
];

// What a step may touch. The worker owns these: the UI names one, it never composes a tool list.
export const CAPABILITIES = [
  { value: "read-only", label: "Read only", hint: "Can read the repository. Cannot change anything." },
  { value: "edit", label: "Read and write", hint: "Can change files. The worker commits afterwards." },
] as const;

export function gateKindByKey(key: string): GateKind | undefined {
  return GATE_KINDS.find((k) => k.key === key);
}
