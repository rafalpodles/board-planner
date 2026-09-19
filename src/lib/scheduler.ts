/**
 * What a background scheduler answers when it is asked to start.
 *
 * `startGithubSyncScheduler` grew this shape first, because two different noes were being told
 * apart badly: a second `register()` — which `next dev` does on reload — answered the same "off" as
 * a scheduler somebody had switched off, and the startup log then said a running sync was not
 * running. The digest had no shape at all (BP-660): it returned `void`, so whether the app armed
 * its timer at boot could not be asserted anywhere.
 *
 * The reason is a parameter rather than one union of every reason, so each scheduler's log handles
 * the answers that scheduler can actually give.
 */
export type SchedulerStart<Reason extends string> =
  | { started: true; tickMs: number }
  | { started: false; reason: Reason };
