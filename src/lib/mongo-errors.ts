/**
 * Which unique index a write collided with, or null if it did not collide at all. A collection
 * with one unique index can get away with reading only the code; `users` has two, and naming the
 * wrong field sends somebody to correct the one that was already right.
 */
export function duplicateKeyField(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  if ((err as { code?: number }).code !== 11000) return null;

  const pattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
  const value = (err as { keyValue?: Record<string, unknown> }).keyValue;
  const [field] = Object.keys(pattern ?? value ?? {});
  // Never "": a duplicate whose field the driver did not name is still a duplicate, and an empty
  // string is falsy — a caller writing `if (conflict)` would turn it back into a 500.
  return field || "unknown";
}
