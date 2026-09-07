/** A list could not be re-read after a write that landed. Shared so its writers — the users page,
 *  the agents store and a project's member list — cannot drift from the tests that assert it, and
 *  so it never grows a verb: it runs after a create, a save, a delete and a grant alike. */
export const LIST_REFRESH_FAILED = "The list could not be refreshed — reload the page to see it";
