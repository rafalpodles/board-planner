export function duplicateKeyField(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  if ((err as { code?: number }).code !== 11000) return null;

  const pattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
  const value = (err as { keyValue?: Record<string, unknown> }).keyValue;
  const [field] = Object.keys(pattern ?? value ?? {});
  return field || "unknown";
}
