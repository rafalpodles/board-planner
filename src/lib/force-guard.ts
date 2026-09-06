import { IUser } from "@/types";

export const MACHINE_FORCE_REFUSAL = "force is not available to a machine credential";

export function machineMayNotForce(
  user: Pick<IUser, "viaMachineCredential">,
  force: unknown
): boolean {
  return force === true && user.viaMachineCredential === true;
}
