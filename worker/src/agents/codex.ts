import { chmodSync, copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSourceHome } from "../env.js";
import { CommandResult } from "../exec.js";
import { parseStream, StreamEvent } from "../stream.js";
import { ExecutionResult, RunOutcome } from "../types.js";
import { AgentRun, CodingAgent, EditCall, ReviewCall, Verdict } from "./agent.js";
import { isExecutionResult, isRecord, isVerdict } from "./shapes.js";

/**
 * Codex CLI (`codex exec`), measured on 0.162.1 with a real ChatGPT login, under this worker's own
 * sandbox profile (BP-987). What those runs showed, and what this adapter does about it:
 *
 * - Its own `--sandbox` modes are not the boundary: `workspace-write` let a write to a temp
 *   directory through, and no second seatbelt profile stacks inside ours, so under our confinement
 *   it runs with `--dangerously-bypass-approvals-and-sandbox` and the kernel profile is the only
 *   wall. A write outside the worktree, to `~/.codex` and to `~` was refused by it.
 * - It writes all over its own home (sessions, sqlite, logs). So a run gets a home of its own, with a
 *   copy of `auth.json` and nothing else, and the profile lets it write there and in the worktree.
 *   The operator's `~/.codex/config.toml`, where a hook or an MCP server would run on the next
 *   invocation, is refused to the kernel. The copy is readable by the run, as the original is:
 *   the profile confines writes and leaves reads alone.
 * - It reads and edits through a shell (`zsh -lc`), and that shell has the network. A Codex step is
 *   therefore not the Claude step with another name: Claude is given no shell and no network at
 *   all. The operator accepted that for Codex (BP-987); the docs say it in these words.
 * - Its default tool set reaches past the sandbox: `web__run` runs on OpenAI's side, and there are
 *   plugins, a browser, computer use, sub-agents and image generation. Switched off below.
 * - A read-only step, and the reviewer, have no tool list to leave the write tools out of, so they
 *   are made read-only by confinement: the worktree is not writable to them (worktreeWritable).
 * - `AGENTS.override.md` and `AGENTS.md` are loaded as instructions from the checkout; the reviewer
 *   is told to load none (`project_doc_max_bytes=0`).
 * - Not measured: what a usage limit looks like (it needs a real limit). Until it is, a limit ends
 *   the step as an error and spends the attempt, which is the cost of not guessing its wording.
 */

// Every feature `codex features list` reports as stable and on that is a capability beyond a shell,
// the patch tool and image viewing
const OFF_FEATURES = [
  "apps",
  "browser_use",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "skill_search",
  "remote_plugin",
  "plugin_sharing",
  "tool_suggest",
  "sleep_tool",
  "memories",
];

const MAX_ERROR_CHARS = 500;

interface CodexItem {
  type?: unknown;
  text?: unknown;
  command?: unknown;
}

function itemOf(event: StreamEvent): CodexItem | undefined {
  const item = (event as { item?: unknown }).item;
  return isRecord(item) ? (item as CodexItem) : undefined;
}

// The shell wrapper Codex puts around every command is the same for all of them
function innerCommand(command: string): string {
  const wrapped = /^\S*sh -lc (['"])([\s\S]*)\1$/.exec(command.trim());
  return wrapped ? wrapped[2] : command;
}

function toTelemetry(event: StreamEvent): StreamEvent[] {
  if (event.type === "turn.completed") return [{ type: "result" }];
  if (event.type !== "item.started") return [];
  const item = itemOf(event);
  if (!item || typeof item.type !== "string" || item.type === "agent_message" || item.type === "error") return [];
  const input = item.type === "command_execution" && typeof item.command === "string" ? { command: innerCommand(item.command) } : {};
  return [{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: item.type === "command_execution" ? "Bash" : item.type, input }] } }];
}

function finalMessage(events: StreamEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== "item.completed") continue;
    const item = itemOf(event);
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  }
  return undefined;
}

function failureOf(events: StreamEvent[]): string | undefined {
  const failed = events.find((event) => event.type === "turn.failed");
  if (!failed) return undefined;
  const error = (failed as { error?: unknown }).error;
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "the turn failed";
  return message.slice(0, MAX_ERROR_CHARS);
}

function parsePayload(text: string | undefined): unknown {
  if (text === undefined) throw new Error("no final message");
  return JSON.parse(text);
}

// OpenAI's structured output is strict: every object says `additionalProperties: false` and lists
// every property as required, or the request is refused with a 400 before the model runs. The
// schemas the worker owns are written for Claude, which does not insist, so they are tightened here.
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) out[key] = strictSchema(value);
  if (out.type === "object" && isRecord(out.properties)) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

export interface CodexOptions {
  /** Where the login is copied from; defaults to the operator's own Codex home */
  sourceHome?: string;
  /** Where each run's home is made; defaults to the temp directory */
  tmp?: string;
}

export function codexAgent(path: string, options: CodexOptions = {}): CodingAgent {
  const base = (model: string, run: AgentRun, extra: string[]) => [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'web_search="disabled"',
    ...OFF_FEATURES.flatMap((feature) => ["--disable", feature]),
    ...extra,
    "-m",
    model,
    "--output-schema",
    join(run.dir ?? "", "schema.json"),
  ];

  return {
    id: "codex",
    tool: "codex",
    path,
    worktreeWritable: (capability) => capability === "edit",
    reviewerWritesCheckout: false,

    async prepare(schema: object) {
      const source = join(options.sourceHome ?? codexSourceHome(), "auth.json");
      if (!existsSync(source)) {
        return { refusal: `codex is not signed in as this user: there is no ${source} (run \`codex login\` as the user the worker runs as)` };
      }
      // Resolved, because the profile matches the resolved path and the CLI is told this one
      const dir = realpathSync(mkdtempSync(join(options.tmp ?? tmpdir(), "cp-codex-")));
      try {
        chmodSync(dir, 0o700);
        copyFileSync(source, join(dir, "auth.json"));
        chmodSync(join(dir, "auth.json"), 0o600);
        writeFileSync(join(dir, "schema.json"), JSON.stringify(strictSchema(schema)), { mode: 0o600 });
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        return { refusal: `could not make a home for the codex run: ${String(error)}` };
      }
      return {
        env: { CODEX_HOME: dir },
        writable: [dir],
        dir,
        cleanup: async () => rmSync(dir, { recursive: true, force: true }),
      };
    },

    editArgs(call: EditCall) {
      // No system-prompt flag: the rules go first in the one prompt. `--` so a prompt can never read as a flag
      return [...base(call.model, call.run, []), "--", `${call.systemPrompt}\n\n---\n\n${call.prompt}`];
    },

    reviewArgs(call: ReviewCall) {
      return [...base(call.model, call.run, ["-c", "project_doc_max_bytes=0"]), "--", `${call.systemPrompt}\n\n---\n\n${call.prompt}`];
    },

    parseEvents: (text) => parseStream(text).flatMap(toTelemetry),

    interpretEdit(result: CommandResult): RunOutcome {
      const events = parseStream(result.stdout);
      const completed = events.some((event) => event.type === "turn.completed");

      if (completed) {
        try {
          const payload = parsePayload(finalMessage(events));
          if (isExecutionResult(payload)) return { kind: "result", result: payload as ExecutionResult };
          return { kind: "error", message: "codex output did not match the result schema" };
        } catch {
          return { kind: "error", message: "could not parse codex output" };
        }
      }

      const failure = failureOf(events);
      if (failure) return { kind: "error", message: `codex reported: ${failure}` };
      if (result.code === 0) return { kind: "error", message: "could not parse codex output" };
      return {
        kind: "error",
        message: `the agent exited ${result.code}${result.stderr ? `\n${result.stderr}` : ""}`,
      };
    },

    parseVerdict(stdout: string): Verdict | null {
      try {
        const events = parseStream(stdout);
        if (!events.some((event) => event.type === "turn.completed")) return null;
        const payload = parsePayload(finalMessage(events));
        return isVerdict(payload) ? payload : null;
      } catch {
        return null;
      }
    },
  };
}
