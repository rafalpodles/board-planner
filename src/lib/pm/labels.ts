/**
 * The markers the system prompt names and the replay writes, in a module of its own so the prompt
 * can say them without importing history's behaviour — `agent.test.ts` mocks `./history`, and a
 * constant reached through a mock is a constant a test can silently change.
 */
export const HISTORY_AUTHOR_PREFIX = "[from @";
export const ACTION_RECORD_LABEL = "Board actions executed in the previous assistant turn";
