/** The list behind a dialog could not be re-read after a write that landed. Shared so the two
 *  writers of it — the users page and the agents store — cannot drift from the tests that assert
 *  it, and so it never grows a verb: it runs after a create, a save and a delete alike. */
export const LIST_REFRESH_FAILED = "The list could not be refreshed — reload the page to see it";
