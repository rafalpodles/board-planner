/** What a catalogue is a fact about. `config.ts` refuses two servers sharing a name. */
export function catalogKey(server: {
  name: string;
  url: string;
  authType: string;
  authToken: string;
  hasAuthToken?: boolean;
}): string {
  // Whether a token exists, never its value, and nothing about the OAuth connection. Both of those
  // change across a save — `pmDraftFrom` blanks `authToken` and `sanitizeMcpServers` fills in
  // `oauthStatus` — so putting them in the key made a catalogue, its success line and that
  // server's whole contribution to the flood warning vanish the moment Save was pressed
  // (BP-569 review 5). Connect and Disconnect clear the entry explicitly instead.
  const tokenPresent = Boolean(server.authToken) || Boolean(server.hasAuthToken);
  return [server.name.trim(), server.url.trim(), server.authType, tokenPresent ? "t" : ""].join("|");
}
