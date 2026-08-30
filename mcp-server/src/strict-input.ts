import { z } from "zod";

/**
 * BP-497: `z.object(shape)` drops a key the shape does not declare, so a call naming a parameter
 * the tool never had was answered 200 having written nothing — and the one field that did move,
 * `updatedAt`, is the one that reads as proof something was written.
 *
 * The advertised schema already said `additionalProperties: false` before this, because
 * zod-to-json-schema emits it for a stripping object as well. So this does not tighten a contract
 * clients were told was loose; it makes the one they were already given true.
 *
 * `hints` names the replacement where there is one. `writes` is whether this tool writes at all,
 * because "nothing was written" is misleading on a tool that never would.
 */
export function unknownParameterMessage(
  keys: string[],
  hints: Record<string, string> = {},
  writes = false
): string {
  return `Not a parameter of this tool: ${keys
    .map((key) =>
      // Own keys only: "__proto__", "constructor" and "toString" are stray keys a confused
      // client really sends, and an inherited hit renders Object.prototype into the message
      Object.hasOwn(hints, key) ? `"${key}" — use ${hints[key]}` : `"${key}"`
    )
    .join("; ")}.${writes ? " Nothing was written." : ""}`;
}

export function strictInput<Shape extends z.ZodRawShape>(
  shape: Shape,
  options: { hints?: Record<string, string>; writes?: boolean } = {}
) {
  const { hints = {}, writes = false } = options;

  const message = (keys: string[]) => unknownParameterMessage(keys, hints, writes);

  type Issue = { code: string; keys?: string[] };
  // zod 3 spells this hook errorMap and zod 4 spells it error; mcp-server is on a different major
  // from the app, and passing both is what lets this file stay identical on either side.
  const params = {
    errorMap: (issue: Issue, ctx: { defaultError: string }) =>
      issue.code === "unrecognized_keys" && issue.keys
        ? { message: message(issue.keys) }
        : { message: ctx.defaultError },
    error: (issue: Issue) =>
      issue.code === "unrecognized_keys" && issue.keys ? message(issue.keys) : undefined,
  };

  return z.object(shape, params as never).strict();
}

export const NOTHING_TO_CHANGE = "named nothing to change. Nothing was written.";

/**
 * Fields a task really has and MCP really cannot set. Before BP-497 they were dropped in silence;
 * a refusal that named them and pointed nowhere would be a different kind of unhelpful.
 */
const UNREACHABLE_TASK_FIELDS: Record<string, string> = {
  dueDate: "the app — MCP does not set it",
  sprint: "the app — MCP does not set it",
  recurrence: "the app — MCP does not set it",
  order: "the app — MCP does not reorder a board",
  blockedBy: "the app — MCP does not link tasks",
  relations: "the app — MCP does not link tasks",
  watchers: "the app — MCP does not set them",
};

const TASK_FIELD_HINTS: Record<string, string> = {
  ...UNREACHABLE_TASK_FIELDS,
  checklist: "acceptanceCriteria, a markdown checklist",
  difficulty: "the fields parameter, keyed by field name",
  component: "the fields parameter, keyed by field name",
  customFieldValues: "the fields parameter, keyed by field name",
};

export const CREATE_TASK_HINTS: Record<string, string> = {
  ...TASK_FIELD_HINTS,
  agent: "update_task, once the task exists",
};

export const UPDATE_TASK_HINTS: Record<string, string> = {
  ...TASK_FIELD_HINTS,
  status: "the change_task_status tool",
  force: "the app: taking a task off a running machine needs a person, so a machine credential — which every MCP token is — is refused",
};

export const CHANGE_STATUS_HINTS: Record<string, string> = {
  force: UPDATE_TASK_HINTS.force,
};
