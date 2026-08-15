import { AgentBucket } from "@/types";
import { normaliseComposition } from "@/lib/agent-rules";

export { CAPABILITIES, GATE_KINDS, MODELS, gateKindByKey } from "@/lib/agent-kinds";
export type { GateKind, ParamSpec } from "@/lib/agent-kinds";

// Labels for the four phases. Purely how the editor presents them; the order is the type's.
export const BUCKETS: { id: AgentBucket; label: string; hint: string }[] = [
  { id: "analysis", label: "Analysis", hint: "Before anything is written" },
  { id: "implementation", label: "Implementation", hint: "Making the change" },
  { id: "verification", label: "Verification", hint: "Judging what was written" },
  { id: "delivery", label: "Delivery", hint: "Sending it somewhere a human can reach" },
];

export const emptyComposition = () => normaliseComposition();
