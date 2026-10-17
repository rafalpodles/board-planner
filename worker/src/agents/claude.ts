import { CommandResult } from "../exec.js";
import { isRateLimitEvent, lastResultEvent, parseStream, ResultEvent, StreamEvent } from "../stream.js";
import { ExecutionResult, RunOutcome } from "../types.js";
import { Capability, CodingAgent, EditCall, ReviewCall, Verdict } from "./agent.js";

// --tools, not --allowedTools. Measured 2026-08-15: under --permission-mode bypassPermissions,
// --allowedTools "Read Grep Glob" still ran Bash, because it is an allowlist for *skipping the
// permission prompt* and nothing prompts. --tools is what decides which built-ins exist at all.
// Owned on this side deliberately. The server names a capability; it never composes a tool list,
// because a prompt composed with the tools it may use is what a capability actually is.
//
// Bash is in neither: it was there for one reason, the agent committing its own work, and the
// worker does that now.
const CAPABILITY_TOOLS: Record<Capability, string> = {
  "read-only": "Read Grep Glob",
  edit: "Read Edit Write Grep Glob",
};

function isUsageLimit(text: string): boolean {
  return /usage limit reached/i.test(text);
}

// The agent writes `result` itself, so a task about this very detection code can put the phrase
// there; only the CLI's exact sentinel counts. stderr stays on the loose match — the CLI owns it.
const USAGE_LIMIT_SENTINEL = /^Claude(?: AI)? usage limit reached\|\d+$/;

function wasRateLimited(events: StreamEvent[]): boolean {
  return events.some((event) => isRateLimitEvent(event) && event.rate_limit_info?.status === "rejected");
}

function reportsUsageLimit(final: ResultEvent | undefined): boolean {
  return typeof final?.result === "string" && USAGE_LIMIT_SENTINEL.test(final.result.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  return (
    isRecord(value) &&
    (value.status === "completed" || value.status === "blocked") &&
    typeof value.summary === "string" &&
    isStringArray(value.filesChanged) &&
    isStringArray(value.testsAdded) &&
    typeof value.blockedReason === "string"
  );
}

function extractResultPayload(final: ResultEvent): unknown {
  if (!("result" in final)) {
    throw new Error("result event has no result field");
  }
  const { result } = final;
  return typeof result === "string" ? JSON.parse(result) : result;
}

function parseExecutionResult(final: ResultEvent | undefined): RunOutcome {
  if (!final) return { kind: "error", message: "could not parse claude output" };
  try {
    const payload = extractResultPayload(final);
    if (!isExecutionResult(payload)) {
      return { kind: "error", message: "claude output did not match the result schema" };
    }
    return { kind: "result", result: payload };
  } catch {
    return { kind: "error", message: "could not parse claude output" };
  }
}

function isVerdict(value: unknown): value is Verdict {
  return isRecord(value) && typeof value.approved === "boolean" && typeof value.reason === "string";
}

function extractEnvelope(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object found in claude output");
    return JSON.parse(stdout.slice(start, end + 1));
  }
}

export function claudeAgent(path: string): CodingAgent {
  return {
    id: "claude",
    tool: "claude",
    path,

    editArgs(call: EditCall) {
      return [
        "-p",
        call.prompt,
        "--output-format",
        "stream-json",
        // the CLI refuses stream-json under -p without it: "requires --verbose"
        "--verbose",
        "--json-schema",
        JSON.stringify(call.resultSchema),
        "--permission-mode",
        "bypassPermissions",
        "--tools",
        CAPABILITY_TOOLS[call.capability],
        // Built-ins are not the whole surface. The same run reported Jira, Notion, GitHub, Figma
        // and Board Planner itself still available from the operator's own ~/.claude.json — so an
        // unattended agent could move the task it is working on, and no gate or diff would see it.
        "--strict-mcp-config",
        "--append-system-prompt",
        call.systemPrompt,
        // The block's model wins over the worker's, so one agent can spend Opus on the change and
        // Sonnet on the step that only reads
        "--model",
        call.model,
        "--fallback-model",
        call.fallbackModel,
      ];
    },

    reviewArgs(call: ReviewCall) {
      return [
        "-p",
        call.prompt,
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(call.verdictSchema),
        "--append-system-prompt",
        call.systemPrompt,
        // The reviewer's whole value is that it only reads; --allowedTools did not make that true
        "--tools",
        "Read Grep Glob",
        "--strict-mcp-config",
        // Every instruction channel the CLI would otherwise discover: CLAUDE.md from the cwd
        // AND from every directory above it, ~/.claude/CLAUDE.md, settings hooks, skills,
        // plugins, custom agents. The clean checkout below cannot close those on its own —
        // measured on 2.1.248, a CLAUDE.md planted in the checkout's PARENT was obeyed, and
        // at the time the agent was handed TMPDIR and wrote with no filesystem sandbox, so
        // choosing a directory was never going to be enough (BP-404 review). BP-349 confines
        // the writer now; this flag stays, because it is what closes the channel by name
        // rather than by reach — including on a machine where the operator turned the sandbox
        // off.
        //
        // --safe-mode rather than --bare: --bare closes the same channels and also makes auth
        // "strictly ANTHROPIC_API_KEY or apiKeyHelper", which this gate deliberately withholds.
        // --safe-mode says auth works normally, and measured, it does.
        "--safe-mode",
        "--model",
        call.model,
      ];
    },

    parseEvents: parseStream,

    interpretEdit(result: CommandResult): RunOutcome {
      // stdout now carries the content of every file the agent read, so nothing here scans it as
      // text: the usage limit is read off typed events, and off stderr, which cannot carry file bodies
      const events = parseStream(result.stdout);
      const final = lastResultEvent(events);

      if (wasRateLimited(events)) return { kind: "usage_limit" };

      // A schema-valid payload is never a usage limit, so settling the success case first makes the
      // text checks below unreachable for any run that actually produced one
      const parsed = parseExecutionResult(final);
      if (parsed.kind === "result") return parsed;

      if (reportsUsageLimit(final) || isUsageLimit(result.stderr)) {
        return { kind: "usage_limit" };
      }

      if (result.code === 0) return parsed;
      // "the agent", not "claude": the exit code now belongs to whichever process died, and since
      // BP-349 that may be the sandbox wrapper rather than the CLI. stderr rides along whatever
      // happened, and carries its own `sandbox-exec:` prefix when the wrapper is the one that
      // refused — which is how a person reading this on the board learns it is the machine and not
      // their task, without this code having to classify anything.
      return {
        kind: "error",
        message: `the agent exited ${result.code}${result.stderr ? `\n${result.stderr}` : ""}`,
      };
    },

    parseVerdict(stdout: string): Verdict | null {
      try {
        const envelope = extractEnvelope(stdout);
        if (!isRecord(envelope) || !("result" in envelope)) return null;
        const payload = typeof envelope.result === "string" ? JSON.parse(envelope.result) : envelope.result;
        return isVerdict(payload) ? payload : null;
      } catch {
        return null;
      }
    },
  };
}
