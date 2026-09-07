/**
 * The bound on a caller's own words when a refusal quotes them back.
 *
 * Every message that carries one of these reaches a model as an MCP tool result — the PM agent, or
 * anything holding a token — so an unbounded echo lets a caller spend the reader's context on a
 * string of its own choosing. 64 is what `task-service.ts` settled on when BP-515 fixed the first
 * four sites, and this exists so the fifth cannot drift from it.
 *
 * The name is the point: BP-515 fixed its sites with an inline `.slice(0, 64)`, and the four in
 * BP-564 were missed because there was nothing to grep for.
 */
export const ECHO_LIMIT = 64;

export function echo(value: unknown): string {
  const text = String(value);
  return text.length > ECHO_LIMIT ? `${text.slice(0, ECHO_LIMIT)}…` : text;
}
