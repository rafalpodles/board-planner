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

/**
 * The coding CLI a step or the review gate runs on. A Claude step has no shell and no network; a
 * Codex step has both, confined to the worktree by the worker's sandbox (BP-987), which is why the
 * choice is the instance admin's, like the prompt.
 */
export const PROVIDERS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["value"];

export const DEFAULT_PROVIDER: ProviderId = "claude";

export const PROVIDER_IDS = PROVIDERS.map((p) => p.value) as ProviderId[];

export function isProvider(value: unknown): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}

/**
 * The models the editor offers for a provider. Empty means a name is typed: Codex's list belongs to
 * the account signed in on the machine, so a fixed list here would be wrong for somebody.
 */
export const MODELS_BY_PROVIDER: Record<ProviderId, readonly { value: string; label: string }[]> = {
  claude: MODELS,
  codex: [],
};

/** The capability a machine names (X-CP-Capabilities) when it can run steps on this provider */
export function providerCapability(provider: ProviderId): string {
  return `agent-${provider}`;
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
    description: "Installs dependencies and builds the project, with npm or with the commands in Settings → Workers.",
    params: [],
    defaults: {},
  },
  {
    key: "test-run",
    name: "Tests pass",
    description: "Runs the whole suite, with npm test or the test command in Settings → Workers.",
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
      { key: "provider", label: "Reviewer", type: "select", options: [...PROVIDERS] },
      { key: "model", label: "Model", type: "select", options: [...MODELS] },
    ],
    defaults: { focus: "general", provider: "claude", model: "opus" },
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
