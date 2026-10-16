import type { CSSProperties } from "react";

export const AVATAR_PALETTE_SIZE = 10;

export function avatarColorIndex(key: string): number {
  let hash = 0x811c9dc5;
  for (const char of key.trim().toLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % AVATAR_PALETTE_SIZE;
}

export function avatarStyle(key: string | null | undefined): CSSProperties | undefined {
  if (!key?.trim()) return undefined;
  return { backgroundColor: `var(--avatar-${avatarColorIndex(key)})` };
}
