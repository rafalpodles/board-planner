export function catalogKey(server: {
  name: string;
  url: string;
  authType: string;
  authToken: string;
  hasAuthToken?: boolean;
}): string {
  const tokenPresent = Boolean(server.authToken) || Boolean(server.hasAuthToken);
  return [server.name.trim(), server.url.trim(), server.authType, tokenPresent ? "t" : ""].join("|");
}
