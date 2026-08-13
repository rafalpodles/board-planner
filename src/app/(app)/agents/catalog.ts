import { AGENT_BUCKETS, AgentBucket, AgentComposition } from "@/types";

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

// The gate implementations the worker has. The catalog rows come from the API; this describes what
// each kind can be configured with, which is a property of the code and belongs beside the form.
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

// What a step may touch. Owned by the worker: the UI names one, it never composes a tool list.
export const CAPABILITIES = [
  { value: "read-only", label: "Read only", hint: "Can read the repository. Cannot change anything." },
  { value: "edit", label: "Read and write", hint: "Can change files. The worker commits afterwards." },
] as const;

export const MODELS = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
] as const;

export const BUCKETS: { id: AgentBucket; label: string; hint: string }[] = [
  { id: "analysis", label: "Analysis", hint: "Before anything is written" },
  { id: "implementation", label: "Implementation", hint: "Making the change" },
  { id: "verification", label: "Verification", hint: "Judging what was written" },
  { id: "delivery", label: "Delivery", hint: "Sending it somewhere a human can reach" },
];

export function gateKindByKey(key: string): GateKind | undefined {
  return GATE_KINDS.find((k) => k.key === key);
}

export function emptyComposition(): AgentComposition {
  const out = {} as AgentComposition;
  for (const bucket of AGENT_BUCKETS) out[bucket] = [];
  return out;
}
