export const HELD_BY_PLAN = "The Free plan runs one machine per organisation, and another one was connected first.";

// Said to the machine, which reads it in its log and the menubar app, where no Upgrade link can follow it
export const HELD_BY_PLAN_ON_THE_MACHINE = `${HELD_BY_PLAN} Upgrade to Pro, or switch the other machine off in Settings → Workers, for this one to take work.`;

export const RECONNECT_ONLY =
  "This organisation is on the Free plan and your machine is its one connected machine, so this token can only connect that machine again. A new machine would be refused.";

export const UPGRADE_HREF = "/settings/organisation";
