import { IUser } from "@/types";

/**
 * `force` takes a task off a machine that is running it, so it needs a person at a keyboard.
 *
 * CLAUDE.md records the principle for the PM agent — "an unattended agent must not take work off
 * a machine" — and BP-305 applied it to the status route. It missed the task PUT, which reaches
 * the identical code path with the identical flag, so one door was locked and the other was not
 * (BP-320). One named rule, so a third writer has something to grep for.
 */
export const MACHINE_FORCE_REFUSAL = "force is not available to a machine credential";

export function machineMayNotForce(
  user: Pick<IUser, "viaMachineCredential">,
  force: unknown
): boolean {
  return force === true && user.viaMachineCredential === true;
}
