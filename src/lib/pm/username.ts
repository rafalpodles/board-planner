/**
 * The PM's account name, in a module of its own so a browser bundle can import it. `pm-user.ts`
 * pulls in bcrypt, crypto and a database connection; `handover.ts` runs in the task detail.
 */
export const PM_USERNAME = "pm";

/** A name as people read it, with the PM's marked as an AI's: "pm" alone reads like a colleague's handle (BP-942). */
export function withAiMark(name: string, username: string | undefined): string {
  return username === PM_USERNAME ? `${name} (AI)` : name;
}
