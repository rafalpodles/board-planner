// Four times the worker's default task timeout. A worker killed mid-run leaves its task in the
// active column, where claimNextTask can never see it again — nothing else reclaims it.
export const EXECUTION_LEASE_MS = 2 * 60 * 60 * 1000;
