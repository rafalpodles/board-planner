// Marks a 429 as a request ceiling (the organisation's, or one account's share of it) rather than
// one action's throttle, so the shell can say so
export const ORGANISATION_LIMIT_HEADER = "x-organisation-limit";

export type RequestLimitScope = "organisation" | "principal";
