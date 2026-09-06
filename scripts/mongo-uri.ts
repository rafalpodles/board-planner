const URI_VARS = ["MONGODB_URI", "MONGO_PUBLIC_URL", "MONGO_URL", "DATABASE_URL"];

export function resolveUri(): { uri: string; source: string } {
  const found = URI_VARS.filter((name) => process.env[name]).map((name) => ({
    source: name,
    uri: process.env[name] as string,
  }));
  if (!found.length) throw new Error(`Set one of: ${URI_VARS.join(", ")}`);

  const reachable = found.filter((c) => !c.uri.includes(".railway.internal"));
  if (!reachable.length) {
    throw new Error(
      `${found.map((c) => c.source).join(", ")} point at Railway's private network ` +
        `(.railway.internal), which only resolves from inside Railway.\n` +
        `Run against the database service instead, which exposes a public address:\n` +
        `  railway run --service MongoDB -- npx tsx scripts/<script>.ts ...`
    );
  }
  return reachable[0];
}

export const dbName = () => process.env.MONGODB_DB || undefined;
